"""Lecture room agent (Windows). Sends the PC screen to the server and executes presentation commands.
Setup: pip install websockets mss pillow pywin32 ; set MCSCMS_SERVER=ws://SERVER_IP:3000 and MCSCMS_KEY=<room key>
(The installer downloaded from the dashboard does all of this for you.)

Troubleshooting: the agent writes agent.log next to this file (pythonw has no window). To test the connection by hand run:
    python agent.py --check
"""
import asyncio, base64, io, json, logging, os, re, sys, tempfile, threading, time, urllib.request
from logging.handlers import RotatingFileHandler
from concurrent.futures import ThreadPoolExecutor

AGENT_VER = 15   # raised with every agent change; the server updates older agents by itself (see self_update)
HERE = os.path.dirname(os.path.abspath(__file__))
log = logging.getLogger('agent'); log.setLevel(logging.INFO)
try: log.addHandler(RotatingFileHandler(os.path.join(HERE, 'agent.log'), maxBytes=500_000, backupCount=1, encoding='utf-8'))
except Exception: pass
if sys.stdout: log.addHandler(logging.StreamHandler(sys.stdout))   # also print when started from a console
for h in log.handlers: h.setFormatter(logging.Formatter('%(asctime)s %(message)s', '%Y-%m-%d %H:%M:%S'))

try:
    import websockets, mss, pythoncom, win32com.client
    from PIL import Image
except Exception as e:   # a missing component used to make the agent vanish without a trace
    log.error('Cannot start, a component is missing or broken: %r. Run the installer again.', e); raise SystemExit(1)

import ctypes
try: ctypes.windll.user32.SetProcessDPIAware()   # screen pictures and mouse positions must use the same (real) pixels
except Exception: pass

_cp = os.path.join(HERE, 'config.json')  # written by the installer
_cfg = json.load(open(_cp)) if os.path.exists(_cp) else {}
SERVER = _cfg.get('server') or os.environ.get('MCSCMS_SERVER', 'ws://192.168.10.2:3000'); KEY = _cfg.get('key') or os.environ.get('MCSCMS_KEY', '')
HTTP = SERVER.replace('ws', 'http', 1)
com = ThreadPoolExecutor(1, initializer=pythoncom.CoInitialize)  # PowerPoint COM must stay on one thread
ppt = pres = None; pdf_name = None; curfile = None; leftovers = []
SLIDES = ('.ppt', '.pptx', '.pps', '.ppsx')    # opened in PowerPoint (slide show, next/previous/blank)
MEDIA = ('.mp4', '.m4v', '.mkv', '.avi', '.mov', '.wmv', '.webm', '.mpg', '.mpeg', '.flv', '.3gp', '.ogv', '.mts', '.m2ts',
         '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.flac', '.wma', '.opus')   # opened in the PC's media player (play/pause)
# Second line of defence (the server already refuses these): never run programs, scripts or macro files on this PC.
BLOCKED = set(('exe msi msp bat cmd com scr pif ps1 psm1 psd1 vbs vbe js jse wsf wsh hta jar lnk url reg dll sys cpl msc inf gadget application appx appxbundle msix msixbundle apk sh bash py pyw rb pl php '
               'docm xlsm pptm dotm xltm potm ppsm ppam xlam xll sldm iso img vhd vhdx dmg chm svg html htm xhtml mht mhtml swf xap crx scf').split())
media_open = False; pc_full = False; filling = False; open_seq = 0
EXPORT_W = 1920   # width of the slide pictures sent to the teacher's laptop (PowerPoint draws them itself, so they match the projector)
deck_gen = int(time.time())   # changes with every lecture; always increasing, even after the agent restarts
ctl = False; cap_rect = None; held_keys = {}; held_btn = set(); cap_mon = 0; mons_n = 1; last_input = 0.0; in_n = 0; in_err = ''; why_last = ''   # cap_mon: display chosen by the person in control (0 = the one the lecture is on); mons_n: how many displays this PC has   # ctl: remote control is on (admin Take control, or faculty on their own device)
hi = False; cap_hwnd = None   # hi: the teacher is in Full screen on their own device, so send a bigger, faster picture. cap_hwnd: window of the lecture, to capture the display it is on
KEYS = {'right': 0x27, 'left': 0x25, 'up': 0x26, 'down': 0x28, 'pgup': 0x21, 'pgdn': 0x22, 'home': 0x24, 'end': 0x23, 'space': 0x20, 'volup': 0xAF, 'voldown': 0xAE, 'mute': 0xAD}   # the only keys a teacher can press remotely (non-slide files)   # pc_full: a non-slide file has been made full screen; open_seq: lets a late full-screen retry notice the lecture changed
# Talk to the server directly. A proxy set in Windows for internet access must never be used for the college LAN.
_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def ws_connect(url):
    kw = dict(max_size=2**23, open_timeout=15, ping_interval=20, ping_timeout=40)
    try:
        if int(websockets.__version__.split('.')[0]) >= 15: kw['proxy'] = None   # websockets 15+ would otherwise follow the Windows proxy
    except Exception: pass
    return websockets.connect(url, **kw)

def download(url, dest):
    with _opener.open(url, timeout=60) as r, open(dest, 'wb') as f:
        while True:
            b = r.read(1 << 20)
            if not b: break
            f.write(b)

def cleanup():
    global curfile
    if curfile: leftovers.append(curfile)
    curfile = None
    for f in leftovers[:]:   # do not leave lectures on the lecture room PC (a file still open in a player is removed on a later pass)
        try:
            if os.path.exists(f): os.remove(f)
            leftovers.remove(f)
        except Exception: pass

def find_window(stem):
    """Top-level visible window whose title contains the lecture's file name (VLC, Windows Media Player, Acrobat, Edge ...)."""
    import win32gui
    found = []; stem = (stem or '').lower()
    def cb(h, _):
        try:
            if stem and win32gui.IsWindowVisible(h) and stem in win32gui.GetWindowText(h).lower(): found.append(h)
        except Exception: pass
    win32gui.EnumWindows(cb, None)
    return found[0] if found else None

def to_front(h):
    """Bring a window to the front. Windows refuses this for a background program unless we borrow the foreground thread's input."""
    import ctypes, win32api, win32con, win32gui
    u = ctypes.windll.user32
    if win32gui.IsIconic(h): win32gui.ShowWindow(h, win32con.SW_RESTORE)
    fg = u.GetForegroundWindow(); t_fg = u.GetWindowThreadProcessId(fg, None); t_me = win32api.GetCurrentThreadId(); attached = False
    try:
        if t_fg and t_fg != t_me: attached = bool(u.AttachThreadInput(t_me, t_fg, True))
        win32gui.BringWindowToTop(h); win32gui.SetForegroundWindow(h)
    finally:
        if attached: u.AttachThreadInput(t_me, t_fg, False)

def fill_window(name, media, seq):
    """PDF, video, audio, documents: they open in the PC's default app. Bring that window to the front and make it fill the display."""
    global pc_full, filling, cap_hwnd
    import ctypes, win32con, win32gui
    stem = os.path.splitext(name)[0]; h = None
    try:
        for _ in range(12):   # the app can take a few seconds to open a big file
            h = find_window(stem)
            if h or seq != open_seq: break
            time.sleep(1)
        if seq != open_seq: return   # the lecture was ended or replaced while we waited
        if not h:
            h = ctypes.windll.user32.GetForegroundWindow()   # some apps (Movies & TV) do not show the file name in their title
            if not h: log.warning('Full screen: could not find the window for %s', name); return
        cap_hwnd = h; to_front(h); win32gui.ShowWindow(h, win32con.SW_MAXIMIZE)
        if media and not pc_full: time.sleep(0.4); key_press(0x7A)   # F11 = full screen in VLC, Movies & TV and browsers. Sent once per lecture, so it never toggles back out
        pc_full = True; log.info('Full screen on the room display: %s', name)
    except Exception as e: log.warning('Full screen failed for %s: %r', name, e)
    finally: filling = False

def key_press(vk):
    import ctypes
    u = ctypes.windll.user32; u.keybd_event(vk, 0, 0, 0); u.keybd_event(vk, 0, 2, 0)

def go_full():
    """Make the lecture that is open fill the room display (called when the teacher presses Full screen)."""
    global pc_full, filling, cap_hwnd
    if pres:   # slide show: switch the running show to full screen and bring it to the front
        w = pres.SlideShowWindow
        try:
            if not w.IsFullScreen: w.IsFullScreen = -1   # msoTrue
        except Exception as e: log.warning('Full screen: could not switch the slide show: %r', e)
        try: w.Activate()
        except Exception: pass
        try: cap_hwnd = w.HWND; to_front(w.HWND)
        except Exception: pass
        log.info('Full screen on the room display: slide show')
    elif pdf_name and not pc_full and not filling:
        filling = True; threading.Thread(target=fill_window, args=(pdf_name, media_open, open_seq), daemon=True).start()

def exit_full():
    """Leave full screen on the room display WITHOUT closing the lecture (the teacher pressed 'Exit presentation full screen')."""
    global pc_full
    import win32con, win32gui
    if pres:
        try: pres.SlideShowWindow.IsFullScreen = 0   # msoFalse: the show keeps running in a window
        except Exception as e: log.warning('Could not leave full screen: %r', e)
    elif pdf_name and pc_full:
        h = cap_hwnd
        try:
            if h: to_front(h)
            if media_open: time.sleep(0.2); key_press(0x7A)   # F11 again: leaves full screen in VLC, Movies & TV and browsers
            elif h: win32gui.ShowWindow(h, win32con.SW_RESTORE)
        except Exception as e: log.warning('Could not leave full screen: %r', e)
    pc_full = False; log.info('Left full screen on the room display (the lecture stays open)')

def close_current():
    """Close whatever is open (slide show or PDF) so a new lecture never stacks on an old one."""
    global pres, pdf_name, media_open, pc_full, open_seq, hi, cap_hwnd, deck_gen
    pc_full = False; open_seq += 1; hi = False; cap_hwnd = None; deck_gen += 1   # a new deck_gen also stops any slide export still running for the old lecture
    if media_open:
        try: media_key(0xB2)   # media 'stop' key: stops the video in the PC's player
        except Exception: pass
        media_open = False
    if pres:
        try: pres.SlideShowWindow.View.Exit()
        except Exception: pass
        try: pres.Close()
        except Exception: pass
        pres = None
    pdf_name = None
    cleanup()

def media_key(vk):
    import ctypes
    u = ctypes.windll.user32; u.keybd_event(vk, 0, 0, 0); u.keybd_event(vk, 0, 2, 0)   # key down, key up

def state():
    global pres
    if pres:
        try:
            st = {'lecture': pres.Name, 'slide': pres.SlideShowWindow.View.CurrentShowPosition, 'total': pres.Slides.Count}
            try: st['idx'] = pres.SlideShowWindow.View.Slide.SlideIndex   # position in the file (the slide's picture number), unlike 'slide' which skips hidden slides
            except Exception: pass
            try: st['full'] = bool(pres.SlideShowWindow.IsFullScreen)
            except Exception: st['full'] = False   # never let this make us forget a running show
            return {'session': st}
        except Exception:
            pres = None  # the slide show was closed on the PC itself
    return {'session': {'lecture': pdf_name, 'slide': 0, 'total': 0, 'full': pc_full}} if pdf_name else {'session': None}

def do(c):
    global ppt, pres, pdf_name, curfile, media_open
    a = c.get('a')
    try:
        if a == 'open':
            close_current()
            name = os.path.basename(c['name']); ext = os.path.splitext(name)[1].lower()
            if not ext or ext[1:] in BLOCKED: log.warning('Refused to open %s (this file type is not allowed)', name); return state()
            f = os.path.join(tempfile.gettempdir(), name); curfile = f; download(HTTP + c['url'], f)
            log.info('Opening %s', name)
            if ext not in SLIDES:   # PDF, video, audio, images, documents: open with this PC's default app
                os.startfile(f); pdf_name = name; media_open = ext in MEDIA
                if c.get('full'): go_full()   # the teacher is in Full screen: fill the room display as soon as the app has opened
                return state()
            ppt = ppt or win32com.client.Dispatch('PowerPoint.Application')
            pres = ppt.Presentations.Open(f, WithWindow=True)
            try: pres.SlideShowSettings.ShowType = 1   # ppShowTypeSpeaker: full screen. A file saved as 'browsed by an individual' would otherwise open in a small window
            except Exception as e: log.warning('Could not set the slide show to full screen mode: %r', e)
            pres.SlideShowSettings.Run()
            try: go_full()   # bring the show to the front, on the room display
            except Exception as e: log.warning('Full screen: %r', e)
        elif a == 'playpause' and media_open: media_key(0xB3)   # media play/pause key
        elif a == 'fullscreen': go_full()
        elif a == 'exitfull': exit_full()
        elif a == 'key' and pdf_name and c.get('k') in KEYS:   # PDF, video, audio, documents: move through them from the teacher's laptop
            if cap_hwnd:
                try: to_front(cap_hwnd)   # the key must reach the lecture, not another window
                except Exception: pass
            key_press(KEYS[c['k']])
        elif pres:
            v = pres.SlideShowWindow.View
            if a == 'next': v.Next()
            elif a == 'prev': v.Previous()
            elif a == 'blank': v.State = 1 if v.State == 3 else 3  # 3 = black screen
            elif a == 'goto': v.GotoSlide(max(1, min(int(c.get('n') or 1), pres.Slides.Count)))
            elif a == 'stop': close_current()
        elif a == 'stop': close_current()
    except Exception as e: log.warning('command %s failed: %r', a, e); pres = None
    return state()

def lecture_monitor(mons):
    """Index of the display the lecture is on (the projector), else the main display."""
    try:
        import win32api
        l, t, r, b = win32api.GetMonitorInfo(win32api.MonitorFromWindow(cap_hwnd, 2))['Monitor']
        for i, m in enumerate(mons[1:], 1):
            if m['left'] == l and m['top'] == t: return i
    except Exception: pass
    return 1 if len(mons) > 1 else 0

def grab():
    global cap_rect, mons_n
    with mss.mss() as s:
        mons_n = max(1, len(s.monitors) - 1)
        m = s.monitors[cap_mon if 0 < cap_mon < len(s.monitors) else lecture_monitor(s.monitors)]; cap_rect = (m['left'], m['top'], m['width'], m['height'])   # mouse positions are mapped onto this display
        im = s.grab(m); img = Image.frombytes('RGB', im.size, im.bgra, 'raw', 'BGRX')
    big = (hi and not pres) or ctl; img.thumbnail((1920, 1080) if ctl else (1280, 720) if big else (640, 360)); b = io.BytesIO(); img.save(b, 'JPEG', quality=75 if ctl else 60 if big else 50)   # remote control: sharp, full-HD picture
    return base64.b64encode(b.getvalue()).decode()

# ---------- Remote control: mouse and keyboard from the admin / faculty browser (only while "ctl" is on) ----------
VKMAP = {'Backspace': 0x08, 'Tab': 0x09, 'Enter': 0x0D, 'NumpadEnter': 0x0D, 'ShiftLeft': 0xA0, 'ShiftRight': 0xA1, 'ControlLeft': 0xA2, 'ControlRight': 0xA3,
         'AltLeft': 0xA4, 'AltRight': 0xA5, 'Pause': 0x13, 'CapsLock': 0x14, 'Escape': 0x1B, 'Space': 0x20, 'PageUp': 0x21, 'PageDown': 0x22, 'End': 0x23,
         'Home': 0x24, 'ArrowLeft': 0x25, 'ArrowUp': 0x26, 'ArrowRight': 0x27, 'ArrowDown': 0x28, 'PrintScreen': 0x2C, 'Insert': 0x2D, 'Delete': 0x2E,
         'MetaLeft': 0x5B, 'MetaRight': 0x5C, 'ContextMenu': 0x5D, 'NumpadMultiply': 0x6A, 'NumpadAdd': 0x6B, 'NumpadSubtract': 0x6D, 'NumpadDecimal': 0x6E,
         'NumpadDivide': 0x6F, 'NumLock': 0x90, 'ScrollLock': 0x91, 'Semicolon': 0xBA, 'Equal': 0xBB, 'Comma': 0xBC, 'Minus': 0xBD, 'Period': 0xBE,
         'Slash': 0xBF, 'Backquote': 0xC0, 'BracketLeft': 0xDB, 'Backslash': 0xDC, 'BracketRight': 0xDD, 'Quote': 0xDE, 'IntlBackslash': 0xE2}
EXT_VK = {0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2C, 0x2D, 0x2E, 0x5B, 0x5C, 0x5D, 0x6F, 0x90, 0xA3, 0xA5}   # "extended" keys need a flag
BTN = {0: (0x0002, 0x0004), 1: (0x0020, 0x0040), 2: (0x0008, 0x0010)}   # browser button 0 left, 1 middle, 2 right -> mouse_event down / up

def vk_of(code):
    if len(code) == 4 and code.startswith('Key') and code[3].isalpha(): return ord(code[3].upper())
    if len(code) == 6 and code.startswith('Digit') and code[5].isdigit(): return ord(code[5])
    if len(code) == 7 and code.startswith('Numpad') and code[6].isdigit(): return 0x60 + int(code[6])
    if code[:1] == 'F' and code[1:].isdigit() and 1 <= int(code[1:]) <= 12: return 0x6F + int(code[1:])
    return VKMAP.get(code)

def kbd(vk, up):
    u = ctypes.windll.user32; u.keybd_event(vk, u.MapVirtualKeyW(vk, 0) & 0xFF, (1 if vk in EXT_VK else 0) | (2 if up else 0), 0)

class _KI(ctypes.Structure): _fields_ = [('wVk', ctypes.c_ushort), ('wScan', ctypes.c_ushort), ('dwFlags', ctypes.c_ulong), ('time', ctypes.c_ulong), ('dwExtraInfo', ctypes.c_size_t)]
class _MI(ctypes.Structure): _fields_ = [('dx', ctypes.c_long), ('dy', ctypes.c_long), ('mouseData', ctypes.c_ulong), ('dwFlags', ctypes.c_ulong), ('time', ctypes.c_ulong), ('dwExtraInfo', ctypes.c_size_t)]
class _IU(ctypes.Union): _fields_ = [('ki', _KI), ('mi', _MI)]
class _IN(ctypes.Structure): _fields_ = [('type', ctypes.c_ulong), ('u', _IU)]

def type_text(text):
    """Type text on the PC as Unicode characters (phone keyboards, pasted text). Works whatever keyboard layout the PC uses."""
    u = ctypes.windll.user32; evs = []
    for ch in text[:200]:
        if ch in '\r\n': kbd(0x0D, False); kbd(0x0D, True); continue
        if ch == '\t': kbd(0x09, False); kbd(0x09, True); continue
        for i in range(0, len(ch.encode('utf-16-le')), 2):
            unit = int.from_bytes(ch.encode('utf-16-le')[i:i + 2], 'little')
            for fl in (0x0004, 0x0006): evs.append(_IN(1, _IU(ki=_KI(0, unit, fl, 0, 0))))   # KEYEVENTF_UNICODE down, then up
    if evs:
        arr = (_IN * len(evs))(*evs); u.SendInput(len(evs), arr, ctypes.sizeof(_IN))

# A small red bar at the top of the room display while someone controls this PC, so the people in the room always know.
_bn = {'q': None}
def _banner_thread(q):
    try:
        import queue, tkinter as tk
        root = tk.Tk(); root.overrideredirect(True); root.attributes('-topmost', True); root.attributes('-alpha', 0.92); root.configure(bg='#b3261e')
        lbl = tk.Label(root, text='', fg='white', bg='#b3261e', font=('Segoe UI', 11, 'bold'), padx=16, pady=4); lbl.pack(); root.withdraw()
        def poll():
            try:
                while True:
                    m = q.get_nowait()
                    if m is None: root.withdraw()
                    else:
                        lbl.config(text=m); root.update_idletasks(); root.geometry('+%d+0' % max(0, (root.winfo_screenwidth() - root.winfo_reqwidth()) // 2)); root.deiconify(); root.attributes('-topmost', True)
            except queue.Empty: pass
            root.after(300, poll)
        root.after(300, poll); root.mainloop()
    except Exception as e: log.warning('Cannot show the remote control notice on screen (%r). Remote control still works.', e)
def banner(msg):
    import queue
    if _bn['q'] is None: _bn['q'] = queue.Queue(); threading.Thread(target=_banner_thread, args=(_bn['q'],), daemon=True).start()
    _bn['q'].put(msg)

def release_all():
    """Let go of every key and mouse button we hold down, so nothing stays stuck on the PC."""
    u = ctypes.windll.user32
    for vk in list(held_keys): kbd(vk, True)
    held_keys.clear()
    for b in list(held_btn): u.mouse_event(BTN[b][1], 0, 0, 0, 0)
    held_btn.clear()

def self_update():
    """The server holds the newest agent.py. Download it, check it is valid Python, replace this file and start again."""
    stamp = os.path.join(HERE, 'update.stamp')
    try:
        if os.path.exists(stamp) and time.time() - os.path.getmtime(stamp) < 600: log.info('Update skipped: one was done less than 10 minutes ago'); return
        with _opener.open(f'{HTTP}/agent.py?key={KEY}', timeout=30) as r: src = r.read()
        compile(src, 'agent.py', 'exec')   # never install a broken file
        me = os.path.abspath(__file__); open(me + '.new', 'wb').write(src); os.replace(me + '.new', me); open(stamp, 'w').write(str(time.time()))
        log.info('Agent updated from the server (was version %s). Restarting.', AGENT_VER)
        import subprocess; subprocess.Popen([sys.executable, me], creationflags=0x00000008 | 0x00000200, close_fds=True); os._exit(0)
    except Exception as e: log.warning('Automatic update failed: %r', e)

def set_ctl(on, who=''):
    global ctl, cap_mon, last_input
    if on: last_input = time.time()
    who = re.sub(r'[^\w .,@-]', '', str(who or ''))[:60]
    if on == ctl:
        if on and who:
            try: banner('Remote control active: %s is using this PC' % who)
            except Exception: pass
        return
    ctl = on
    if not on:
        cap_mon = 0   # the next person starts on the lecture display again
        try: release_all()
        except Exception: pass
    try: banner('Remote control active: %s is using this PC' % (who or 'AV staff') if on else None)
    except Exception: pass
    log.info('Remote control %s%s', 'STARTED' if on else 'ended', ' by ' + who if on and who else '')

warned = {}
def cursor_norm():
    """Where the PC's mouse pointer is, as 0..1 of the captured display (the screen picture itself does not contain the pointer)."""
    try:
        import ctypes.wintypes
        pt = ctypes.wintypes.POINT(); ctypes.windll.user32.GetCursorPos(ctypes.byref(pt)); l, t, w, h = cap_rect or (0, 0, 1, 1)
        return [round(min(max((pt.x - l) / max(w, 1), 0), 1), 4), round(min(max((pt.y - t) / max(h, 1), 0), 1), 4)]
    except Exception: return None

def input_desktop():
    """Join the desktop that is receiving input right now. Windows refuses mouse moves from a program that sits on another desktop (after a lock, a disconnected remote session, a permission prompt)."""
    try:
        u = ctypes.windll.user32; h = u.OpenInputDesktop(0, False, 0x10000000)
        if h: ok = u.SetThreadDesktop(h); u.CloseDesktop(h); return bool(ok)
    except Exception: pass
    return False

def why_refused(err):
    """One line that says WHY Windows refused: error code, the session and desktop this agent runs on, and whether it is elevated."""
    try:
        u, k = ctypes.windll.user32, ctypes.windll.kernel32; sid = ctypes.c_ulong(0); k.ProcessIdToSessionId(os.getpid(), ctypes.byref(sid))
        con = k.WTSGetActiveConsoleSessionId(); buf = ctypes.create_unicode_buffer(64); n = ctypes.c_ulong(0)
        h = u.GetThreadDesktop(k.GetCurrentThreadId()); u.GetUserObjectInformationW(h, 2, buf, ctypes.sizeof(buf), ctypes.byref(n))
        hi = u.OpenInputDesktop(0, False, 0x0100)   # DESKTOP_SWITCHDESKTOP: can this program see the desktop that gets the keyboard and mouse?
        if hi: u.CloseDesktop(hi)
        adm = ctypes.windll.shell32.IsUserAnAdmin()
        return 'Windows error %s | agent session %s, console session %s | agent desktop %s | input desktop %s | admin %s | python %s %s-bit' % (err, sid.value, con, buf.value or '?', 'reachable' if hi else 'NOT reachable', 'yes' if adm else 'no', sys.version.split()[0], 64 if sys.maxsize > 2**32 else 32)
    except Exception as ex: return 'Windows error %s (details unavailable: %r)' % (err, ex)

def move_cursor(x, y):
    """Move the pointer: normal way first, then after joining the input desktop, then as a typed-in absolute mouse move (SendInput)."""
    u = ctypes.windll.user32
    global why_last
    if u.SetCursorPos(x, y): return True
    err = getattr(ctypes, 'GetLastError', lambda: 0)()
    if input_desktop() and u.SetCursorPos(x, y): return True
    vx, vy, vw, vh = u.GetSystemMetrics(76), u.GetSystemMetrics(77), max(1, u.GetSystemMetrics(78)), max(1, u.GetSystemMetrics(79))   # the whole (virtual) desktop
    ax, ay = int((x - vx) * 65535 / max(vw - 1, 1)), int((y - vy) * 65535 / max(vh - 1, 1))
    if u.SendInput(1, ctypes.byref(_IN(0, _IU(mi=_MI(ax, ay, 0, 0x0001 | 0x8000 | 0x4000, 0, 0)))), ctypes.sizeof(_IN)): return True   # MOVE | ABSOLUTE | VIRTUALDESK
    why_last = why_refused(err); return False

def ctl_input(e):
    global last_input, in_n, in_err
    if not ctl: return
    u = ctypes.windll.user32; k = e.get('k'); last_input = time.time(); in_n += 1
    try:
        if k in ('mv', 'md', 'mu'):
            l, t, w, h = cap_rect or (0, 0, u.GetSystemMetrics(0), u.GetSystemMetrics(1))
            if move_cursor(int(l + min(max(float(e.get('x', 0)), 0), 1) * (w - 1)), int(t + min(max(float(e.get('y', 0)), 0), 1) * (h - 1))): in_err = ''
            else:
                in_err = ('Windows refused to move the mouse. ' + why_last)[:210]
                if not warned.get('cur'): warned['cur'] = 1; log.warning('Windows refused to move the mouse. %s', why_last)
            b = int(e.get('b', 0))
            if k == 'md' and b in BTN: u.mouse_event(BTN[b][0], 0, 0, 0, 0); held_btn.add(b)
            elif k == 'mu' and b in BTN: u.mouse_event(BTN[b][1], 0, 0, 0, 0); held_btn.discard(b)
        elif k == 'dbl':   # a reliable double-click, however slow the network is
            l, t, w, h = cap_rect or (0, 0, u.GetSystemMetrics(0), u.GetSystemMetrics(1))
            move_cursor(int(l + min(max(float(e.get('x', 0)), 0), 1) * (w - 1)), int(t + min(max(float(e.get('y', 0)), 0), 1) * (h - 1)))
            for _ in range(2): u.mouse_event(0x0002, 0, 0, 0, 0); u.mouse_event(0x0004, 0, 0, 0, 0); time.sleep(0.03)
        elif k == 'wx': u.mouse_event(0x01000, 0, 0, (120 if float(e.get('dy', 0)) > 0 else -120) & 0xFFFFFFFF, 0)   # sideways scroll
        elif k == 'tx': type_text(str(e.get('t', ''))[:200])
        elif k == 'wh':
            dy = float(e.get('dy', 0)); n = max(1, min(5, round(abs(dy) / 100)))
            u.mouse_event(0x0800, 0, 0, (-120 * n if dy > 0 else 120 * n) & 0xFFFFFFFF, 0)   # browser: down is positive; Windows: up is positive
        elif k in ('kd', 'ku'):
            vk = vk_of(str(e.get('c', '')))
            if not vk: return
            kbd(vk, k == 'ku')
            if k == 'kd': held_keys[vk] = 1
            else: held_keys.pop(vk, None)
        elif k == 'rel': release_all()
    except Exception as ex: in_err = repr(ex)[:80]; log.warning('remote input failed: %r', ex)

# ---------- File transfer: files sent from the teacher's / staff member's own device ----------
# Only this folder tree is ever written or opened: <Public Documents>\MCSCMS Files\<folder>\<user>. Nothing outside it, and no program or script files.
XROOT = os.path.join(os.environ.get('PUBLIC') or 'C:\\Users\\Public', 'Documents', 'MCSCMS Files')
XOK = set(('.ppt .pptx .pps .ppsx .pdf .doc .docx .xls .xlsx .odt .ods .odp .rtf .txt .csv .jpg .jpeg .png .gif .bmp .webp .tif .tiff ' + ' '.join(MEDIA)).split())
_FOLDER = re.compile(r'^[A-Za-z0-9 _-]{1,30}$'); _USER = re.compile(r'^[A-Za-z0-9_-][A-Za-z0-9 _.-]{0,59}$')

def xdir(folder, user):
    if not _FOLDER.match(str(folder or '')) or not _USER.match(str(user or '')): raise ValueError('That folder is not allowed.')
    root = os.path.realpath(XROOT); d = os.path.realpath(os.path.join(root, folder, user))
    if os.path.commonpath([root, d]) != root or d == root: raise ValueError('That folder is not allowed.')
    return d

def xname(name):
    n = re.sub(r'[\x00-\x1f<>:"/\\|?*]', '_', re.split(r'[\\/]', str(name or ''))[-1]).strip('. ')[:120]; ext = os.path.splitext(n)[1].lower()
    if not n or ext not in XOK or ext[1:] in BLOCKED: raise ValueError('This file type is not allowed on a lecture room PC.')
    return n

def bring_up(name):
    """Bring the window of a file we just opened to the front on the room display."""
    global cap_hwnd
    import win32con, win32gui
    try:
        for _ in range(12):
            h = find_window(os.path.splitext(name)[0])
            if h: cap_hwnd = h; to_front(h); win32gui.ShowWindow(h, win32con.SW_MAXIMIZE); return
            time.sleep(1)
    except Exception as e: log.warning('Could not bring %s to the front: %r', name, e)

def handle_x(c):
    """(worker thread) xsave: download a file the server holds for this room; xlist: list the folder; xopen: open a file in it."""
    a = c.get('a')
    try:
        d = xdir(c.get('folder'), c.get('user')); os.makedirs(d, exist_ok=True)
        if a == 'xlist':
            files = []
            for n in os.listdir(d):
                f = os.path.join(d, n)
                if os.path.isfile(f) and os.path.splitext(n)[1].lower() in XOK: files.append((os.path.getmtime(f), n, os.path.getsize(f)))
            files.sort(reverse=True); return {'ok': True, 'op': a, 'files': [{'name': n, 'size': z} for _, n, z in files[:100]]}
        n = xname(c.get('name'))
        if a == 'xsave':
            stem, ext = os.path.splitext(n); dest = os.path.join(d, n); i = 1
            while os.path.exists(dest): dest = os.path.join(d, f'{stem} ({i}){ext}'); i += 1
            tmp = dest + '.part'
            try:
                download(HTTP + c['url'], tmp)
                if c.get('size') and os.path.getsize(tmp) != int(c['size']): raise IOError('The file arrived incomplete. Please send it again.')
                os.replace(tmp, dest)
            finally:
                if os.path.exists(tmp):
                    try: os.remove(tmp)
                    except Exception: pass
            log.info('Saved %s from %s into %s', os.path.basename(dest), c.get('user'), c.get('folder')); return {'ok': True, 'op': a, 'name': os.path.basename(dest)}
        if a == 'xopen':
            f = os.path.realpath(os.path.join(d, n))
            if os.path.dirname(f) != d or not os.path.isfile(f): raise ValueError('That file is not in the folder any more.')
            os.startfile(f); log.info('Opened %s for %s', n, c.get('user')); threading.Thread(target=bring_up, args=(n,), daemon=True).start()
            return {'ok': True, 'op': a, 'name': n}
        raise ValueError('Unknown request.')
    except Exception as e:
        log.warning('File transfer %s failed: %r', a, e)
        return {'ok': False, 'op': a, 'error': str(e)[:160] if isinstance(e, (ValueError, IOError)) else 'The room PC could not complete this (%s).' % type(e).__name__}

def export_slide(gen, i):
    """(PowerPoint thread) PowerPoint draws slide i as a picture: exactly what the projector shows, at full quality."""
    if gen != deck_gen or not pres: return None
    w = EXPORT_W; h = max(1, int(round(w * pres.PageSetup.SlideHeight / pres.PageSetup.SlideWidth)))
    f = os.path.join(tempfile.gettempdir(), f'mcscms-slide-{gen}-{i}.png')
    pres.Slides(i).Export(f, 'PNG', w, h)
    return f

def upload_slide(gen, i, total, f):
    try:
        with open(f, 'rb') as fh: data = fh.read()
    finally:
        try: os.remove(f)
        except Exception: pass
    req = urllib.request.Request(f'{HTTP}/deck/{gen}/{i}?key={KEY}&total={total}', data=data, method='POST', headers={'Content-Type': 'image/png'})
    with _opener.open(req, timeout=60) as r: r.read()

def why(e):
    """Readable reason from a closed WebSocket (the server says why it refused this agent)."""
    code = getattr(e, 'code', None) or getattr(getattr(e, 'rcvd', None), 'code', None)
    reason = getattr(e, 'reason', None) or getattr(getattr(e, 'rcvd', None), 'reason', None)
    return f'server closed the connection ({code}: {reason})' if code else repr(e)

async def run():
    loop = asyncio.get_running_loop(); shot_ok = True
    async def safe_frame():
        """A screen that cannot be captured (locked PC, display off) must never drop the connection."""
        nonlocal shot_ok
        try: img = await loop.run_in_executor(None, grab)
        except Exception as e:
            if shot_ok: log.warning('Cannot capture the screen (%r). The room stays Online without a preview.', e); shot_ok = False
            return None
        if not shot_ok: log.info('Screen capture works again'); shot_ok = True
        return img
    async def get_state():
        try: return await asyncio.wait_for(loop.run_in_executor(com, state), 3)
        except Exception: return None   # PowerPoint is busy opening a file: try again next time
    async def export_deck(gen):
        """Send every slide of the running lecture to the server as a full-quality picture, in the background.
        Each export is one short step on the PowerPoint thread, so Next / Previous never wait more than a moment."""
        try:
            total = await loop.run_in_executor(com, lambda: pres.Slides.Count if pres and gen == deck_gen else 0)
            for i in range(1, total + 1):
                if gen != deck_gen: return   # the lecture ended or changed
                f = await loop.run_in_executor(com, export_slide, gen, i)
                if not f: return
                await loop.run_in_executor(None, upload_slide, gen, i, total, f)
            log.info('All %s slides sent to the server in full quality', total)
        except Exception as e: log.warning('Could not send the slide pictures: %r. The teacher still sees the live preview.', e)
    log.info('Agent started. Server %s', SERVER)
    wait = 5
    while True:
        try:
            async with ws_connect(f'{SERVER}/ws?key={KEY}') as ws:
                log.info('Connected to server (agent version %s)', AGENT_VER); wait = 5
                await ws.send(json.dumps({'t': 'hello', 'ver': AGENT_VER}))
                async def sender():
                    last = 0; last_h = None; last_sent = 0
                    while True:
                        img = await safe_frame()
                        if img and (hash(img) != last_h or time.time() - last_sent > 3):   # an unchanged screen is not sent again (saves bandwidth for phones)
                            last_h = hash(img); last_sent = time.time(); await ws.send(json.dumps({'t': 'frame', 'data': img, 'mons': mons_n}))
                        if ctl and (held_keys or held_btn) and time.time() - last_input > 30: release_all(); log.info('Released keys that were held for 30 s with no input')
                        if time.time() - last >= 0.9:   # about every second: the slide counter stays live (and the server hears from us), even when slides are changed on the PC itself
                            st = await get_state(); last = time.time()
                            if st is not None: await ws.send(json.dumps({'t': 'state', 'state': st}))
                        await asyncio.sleep(0.06 if ctl else 0.4 if hi and not pres else 1)   # remote control: about 7 pictures a second
                async def reader():
                    async for m in ws:
                        try: c = json.loads(m)
                        except ValueError: continue
                        if c.get('t') != 'cmd': continue
                        if c.get('a') == 'update': await loop.run_in_executor(None, self_update); continue
                        if c.get('a') in ('xsave', 'xlist', 'xopen'):   # file transfer runs on its own thread; the screen keeps updating meanwhile
                            async def xjob(c=c):
                                r = await loop.run_in_executor(None, handle_x, c); await ws.send(json.dumps({'t': 'xres', 'id': c.get('id'), **r}))
                            asyncio.ensure_future(xjob()); continue
                        if c.get('a') == 'mon':
                            globals()['cap_mon'] = max(0, min(8, int(c.get('n') or 0))); continue
                        if c.get('a') == 'rc':
                            set_ctl(bool(c.get('on')), c.get('who'))   # remote control on / off
                            if ctl: await ws.send(json.dumps({'t': 'rcready'}))   # tells the dashboard that this PC will obey the mouse and keyboard
                            continue
                        if c.get('a') == 'input': ctl_input(c.get('e') or {}); continue   # one mouse or keyboard event
                        if c.get('a') == 'stream': globals()['hi'] = bool(c.get('hi')); continue   # picture size/speed, no lecture command
                        st = await loop.run_in_executor(com, do, c); await ws.send(json.dumps({'t': 'state', 'state': st}))
                        if c.get('a') == 'open' and (st.get('session') or {}).get('total'): asyncio.ensure_future(export_deck(deck_gen))
                async def curs():   # pointer position + how many mouse/keyboard events this PC has received, a few times a second
                    last_c = None
                    while True:
                        if ctl:
                            cur = cursor_norm(); key = (tuple(cur) if cur else None, in_n, in_err)
                            if key != last_c: last_c = key; await ws.send(json.dumps({'t': 'cur', 'cur': cur, 'n': in_n, 'err': in_err}))
                        await asyncio.sleep(0.04)
                await asyncio.gather(sender(), reader(), curs())
        except Exception as e:
            set_ctl(False)   # never leave a key or button held down when the link is lost
            msg = why(e)
            wait = 30 if ('address in use' in msg or 'unknown agent' in msg) else 5   # refused on purpose: no point hammering the server
            log.warning('Disconnected, retrying in %s s: %s', wait, msg); await asyncio.sleep(wait)

def check():
    """python agent.py --check : step-by-step test of everything the agent needs."""
    bad = 0
    def step(name, fn):
        nonlocal bad
        try: r = fn(); print(f'  OK    {name}' + (f': {r}' if r else ''))
        except Exception as e: bad += 1; print(f'  FAIL  {name}: {e}')
    print(f'Agent check. Server {SERVER}')
    def cfg():
        if not KEY: raise Exception('no Agent ID in config.json. Run the installer again')
    step('Settings file', cfg)
    step('Components (websockets, mss, pillow, pywin32)', lambda: 'websockets ' + websockets.__version__)
    def http():
        with _opener.open(HTTP + '/api/lr', timeout=10) as r: return f'HTTP {r.status}'
    step('Server reachable (no proxy)', http)
    step('Screen capture', lambda: f'{len(grab()) // 1024} KB frame')
    def inp():
        u = ctypes.windll.user32; pt = ctypes.wintypes.POINT()
        if not u.GetCursorPos(ctypes.byref(pt)) or not u.SetCursorPos(pt.x, pt.y): raise Exception('Windows would not let this program move the mouse (is the PC locked?)')
        return f'mouse can be moved, agent version {AGENT_VER}'
    import ctypes.wintypes
    step('Remote control (mouse and keyboard)', inp)
    def xt():
        d = xdir('Lectures', '_check'); os.makedirs(d, exist_ok=True); t = os.path.join(d, 'test.tmp'); open(t, 'w').write('x'); os.remove(t); os.rmdir(d); return 'files can be received in ' + XROOT
    step('File transfer folder', xt)
    def tkc():
        import tkinter; return 'on-screen remote control notice available'
    step('On-screen notice (tkinter)', tkc)
    step('PowerPoint available', lambda: (win32com.client.Dispatch('PowerPoint.Application') and 'found'))
    async def wst():
        async with ws_connect(f'{SERVER}/ws?key={KEY}') as ws:
            try: await asyncio.wait_for(ws.recv(), 2)
            except asyncio.TimeoutError: return 'server accepted this agent'
            except Exception as e: raise Exception(why(e))
    step('Server accepts this agent', lambda: asyncio.run(wst()))
    print('\nAll checks passed.' if not bad else f'\n{bad} check(s) failed. Fix the FAIL lines above, then run the installer again.')
    return 1 if bad else 0

if __name__ == '__main__':
    if '--check' in sys.argv: sys.exit(check())
    asyncio.run(run())
