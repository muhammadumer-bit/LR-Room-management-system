# Lecture Room Control (MCSCMS)

Faculty present their slides on the lecture room (LR) PC and projector, with no cable and no help from AV staff. AV staff and admins watch every room from one central monitor.

## How it works, in short
1. **AV or admin adds each lecture room** by name (and floor). The system creates a unique **Agent ID** for it and an installer.
2. **The installer is run once on the LR PC.** From then on the room appears on the monitor by itself. Nobody types IP addresses: the server learns the PC's address when its agent connects, and follows the PC if its address changes.
3. **The teacher opens "Lecture Room Login" on the LR PC,** signs in, and that specific LR opens. They drop in a slide file ("Upload and present"), and it opens straight away on that PC and projector.
4. **AV and admin see every room live:** screen, who is signed in, lecture title, slide progress, how long it has run, and a short activity timeline per room.

## How the login works
- **On the LR PC:** faculty sign in on the PC itself. The server matches the browser to the room whose agent runs on that PC, and the login is tied to that one room.
- **From their own phone or laptop (new):** faculty sign in from any other device, then **choose a lecture room** from a list. Only rooms that are online and free can be chosen. See *Sharing from your own phone or laptop* below. Admin can switch this off with `allowRemoteFaculty` (then faculty can sign in on LR PCs only, as before).
- **A faculty login is tied to one LR at a time.** Slides open and are controlled on that LR only.
- **One login, one LR at a time.** If the same account tries a second LR while it is signed in on the first, it is refused and told where it is signed in. One LR also serves one faculty login at a time.
- **Signing out ends the lecture** and closes the file on the LR PC. Closing the browser frees the LR after 3 minutes, unless a lecture is running.
- **Stuck login?** Admin or AV staff open **Sign-ins** and press **Release** (or use *Release faculty sign-in* on the Live monitor).
- Admin and AV accounts can sign in from any device.

## Sharing from your own phone or laptop
1. Open the server address (`http://SERVER_IP:3000`) on the phone or laptop and sign in with the faculty account.
2. Under **Choose a lecture room** pick the room (it must show *Available*). Upload a PowerPoint or PDF from the device, or choose one already in your list, and press **Present**.
3. The slides open on **that room's PC and projector only**. The phone becomes the remote: **Next slide**, **Previous**, **Blank screen**, **End lecture**, with a live view of the room's screen so you can see it is the right projector.
4. **Change room** (disabled while a lecture is running) lets you pick another room. **Sign out** ends the lecture and frees the room.

How the "only the selected room" rule is enforced on the server:
- A faculty browser can only ever send commands to the room stored in its own login. A room name sent by the browser is ignored.
- A room serves one faculty login at a time. A room that is in use, offline, or being controlled by AV staff cannot be selected.
- Each room's agent may download only the lecture that was opened on **its own** room. Other rooms' agents, and anyone without the Agent ID, get a refusal.
- Selection, hand-over and disconnecting are written to the Activity log. AV and admin see remote logins on **Sign-ins** (marked *own device*).
- The same account signing in on a second device takes over from the first device and keeps its room and running lecture.

## Full screen presenter view
- Faculty press **Full screen** in the top bar (or the **F** key). The page goes full screen and shows a presenter view built for a laptop or tablet: a large live view of the room's screen (when signed in from their own device), **Previous / Next / Blank / End lecture**, the slide counter and progress bar, and, when nothing is running, a lecture list with **Present** and **Upload**.
- Keys: **→** or **Space** next, **←** previous, **B** blank, **Space** play/pause for a video, **Esc** exits. On devices that cannot go truly full screen (some phones) the same view fills the browser window instead.
- **Full screen also takes over the room display (new).** Pressing **Full screen** (or **F**) sends a command to that room's PC as well, so the lecture fills the room's screen and projector with no help from the AV technician.
  - **Slides (ppt, pptx, pps, ppsx):** the slide show is switched to full screen and brought to the front. Every slide show is now started in full-screen mode, even if the file was saved as "browsed by an individual (window)".
  - **Video, audio, PDF and other files:** the window of the app that opened the file is found, brought to the front and maximized. For video and audio the player's full-screen key (**F11**) is also sent once. The result depends on the PC's default app, so test it once per room with your usual player.
  - If the teacher is already in Full screen when they press **Present**, the lecture opens full screen straight away. Otherwise, while a lecture runs, a **Full screen on room** button in the presenter view does it, and a **Full screen on LR-x** badge shows when it is done.
  - **Slides in original quality, in step with the room PC (new).** When a PowerPoint lecture starts, PowerPoint on the room PC draws every slide as a 1920 px picture and sends them to the server in the background. The teacher's laptop shows those pictures instead of a screen copy, so the quality is the same as the projector. The laptop follows the room PC's current slide, and the teacher drives both from the laptop:
    - **Next / Previous**, the arrow keys (**→ ↓** next, **← ↑** previous), **Page up / Page down** and **Space** change the slide on the room PC, and the laptop shows the new slide at once.
    - **Go to slide** (list at the bottom) jumps to any slide. A small **Next** preview shows what comes after.
    - If the slide is changed on the room PC itself, the laptop follows (within about a second). The laptop never shows a slide the room PC was not told about: if the connection is lost, it keeps the last confirmed slide and reconnects by itself.
    - **Esc** leaves the laptop's full-screen view only. The lecture keeps running on the room PC; **End lecture** ends it, so a stray key can never stop a lecture.
    - Several rooms can present at the same time. Every command, slide picture and screen preview belongs to the one room in the teacher's own login, and a room name sent by a browser is ignored.
    - While the pictures are being prepared (a few seconds for a small file, longer for a big one) the laptop shows the live preview and a "Preparing slides 12/40" note.
    - The pictures are kept on the server only while the lecture runs, are shown only to that room's faculty login and to staff, and are deleted when the lecture ends. Animations, transitions and embedded videos run on the room PC only; the laptop shows each slide as a still picture.
    - For a different picture size change `EXPORT_W` at the top of `agent.py` (1920 by default).
  - **Manage everything from the laptop.** For PDF, video and other non-slide files, in Full screen on their own device, the teacher sees a larger, faster live picture of the room display (about 1280 px wide, 2 to 3 pictures a second, only while Full screen is on). The picture shows the display the lecture is on, which is the projector, not always the PC's main monitor.
  - **PDF, documents and images:** buttons and keyboard keys (**Page up / Page down**, **Scroll up / down**, arrow keys, Space) are sent to the lecture window on the room PC. **Video and audio:** **Back / Forward**, **Play / Pause**, **Vol − / Vol +**, **Mute**. Only these keys can be sent, nothing else.
  - **Exit full screen** (or **Esc**) leaves only the teacher's laptop view. The room display is left alone so the lecture is never disturbed.
  - Every full-screen request is written to the Activity log. The agent only acts on its own room's lecture.
- Outside Full screen the live view is a small preview (about one picture per second). In Full screen it is larger and faster, see above.
- Signed in on the LR PC itself, the presenter view shows a large slide counter instead of the preview, since the slides are already on that PC's own screen.

## Remote control: mouse and keyboard on the room PC (new)
**Take control** now works like Remote Desktop or VNC.
- **Admin / AV:** on **Live monitor**, select a room and press **Take control**. The room's screen opens full size. Your mouse (move, click, right-click, drag, wheel) and your keyboard (all letters, numbers, F1-F12, arrows, Ctrl/Alt/Shift, Esc, Tab, Windows key) now work on that PC. Press **Release control** (top right) when finished. The room is then free again for the faculty member.
- **Faculty on their own phone or laptop:** in **Full screen**, press **Control room PC**. It works only on the faculty member's own room, only while no staff member holds it, and the Windows key is blocked. Faculty signed in on the room PC itself do not need it (they already use that PC).
- While remote control is on, the picture is larger and faster (about 7 pictures a second).
- Keys stuck down are released automatically when you release control, close the browser, switch windows or the connection drops.
- Every start and end of remote control is written to the Activity log and the room's timeline.
- Turn faculty remote control off with `allowFacultyControl` = `false` in `data/config.json` (admin and AV keep it).
- Limits: Windows blocks injected input on the **lock screen** and on **UAC (administrator permission) prompts**, so those cannot be clicked remotely. **Ctrl+Alt+Del** cannot be sent. With two displays, the picture and mouse follow the display the lecture is on (the projector) or the main display when no lecture is open. For Esc, Tab and shortcuts to reach the room PC, use full screen in Chrome or Edge.
- **Agent updates (new):** every agent reports its version when it connects. If the server holds a newer `agent.py`, the agent downloads it, checks it, replaces itself and restarts, with no visit to the PC. This works once an agent is version 11 or newer. A room PC with an older agent (it ignores mouse and keyboard, so the screen is view-only) must have its **Installer** run **once**; after that it keeps itself up to date. The remote control window says so if the room PC has not answered, and `agent.log` shows `agent version 11`.
- To test a room PC: `python %LOCALAPPDATA%\MCSCMS\agent.py --check` now includes a *Remote control (mouse and keyboard)* line.

## Remote desktop, touch, file transfer (agent version 12)

- **Control room PC** (faculty on their own device) and **Take control** then **Remote control** (admin / AV) open the same full-screen remote desktop: mouse, right-click, double-click, drag, wheel, and the real keyboard (Ctrl/Alt/Shift combinations, F-keys, arrows). Chrome / Edge also pass Esc and Tab through in full screen.
- **Phones and tablets:** tap = click, two quick taps = double-click, hold = right-click, one finger = move the pointer, **Drag** button = one finger drags, two fingers = scroll. **Keyboard** opens the on-screen keyboard; **Keys** has Esc, Tab, Del, arrows, Ctrl/Alt/Shift, Copy/Paste, Alt+Tab; **Paste text...** types a long text on the PC.
- **Presentation** (in the remote desktop bar) switches to slide controls without leaving the desktop: previous, next, blank, go to slide, **Exit presentation full screen**, **End lecture**. **Exit remote control** and **Exit full screen** on your own device never close the lecture.
- **Files / Send files:** send slides, PDF, Word, Excel, text, images, audio and video (up to `transferMaxMB`) to one of the allowed folders on the room PC (`Public Documents\MCSCMS Files\<folder>\<your username>`), see progress, then **Open on room PC**. Programs, scripts, macro files and files whose content does not match their type are refused by the server and again by the agent.
- **Visible to the room:** while someone controls a PC, a red notice "Remote control active: <name>" is shown at the top of its display, and the room card shows who is controlling. Every start/end (with duration and number of inputs), file transfer and file opening is in the Activity log.
- Remote control survives a dropped connection: the browser and the server re-establish it by themselves; if the PC itself blinks, control resumes without a new Take control.
- **Update the LR PCs:** agents with version 11 update themselves to 12 when they next connect (no visit needed). Version 12 needs Python's `tkinter` (included with the python.org installer) only for the on-screen notice.
- **HTTPS / WSS:** set `MCSCMS_TLS_KEY` and `MCSCMS_TLS_CERT` (PEM files) before `node server.js`, or put the server behind a TLS reverse proxy and set `MCSCMS_PUBLIC_SCHEME=https`. Installers then use https / wss. The certificate must be trusted by the LR PCs (college CA or a public certificate).

## Lecture files: any type, including video
- Faculty and staff can upload **any lecture file**: slides (ppt, pptx, pps, ppsx), PDF, **video** (mp4, mkv, avi, mov, wmv, webm ...), audio, images, Word/Excel/text and other files. Files are streamed to disk, so large videos are fine. The limit is `maxUploadMB` (default 2048 MB).
- **Not allowed:** programs and scripts (exe, bat, cmd, ps1, vbs, js, msi, lnk ...), macro-enabled Office files (pptm, docm, xlsm ...), web pages (html, svg) and disk images. The agent opens lectures on the lecture room PC, so these are refused by the browser, by the server and again by the agent.
- How each type opens on the LR PC: **slides** in PowerPoint with Next / Previous / Blank; **video and audio** in the PC's default media player with **Play / Pause** and **End lecture** (which sends the media Stop key); **PDF and everything else** in the PC's default app, to be moved through with the PC's mouse or keyboard.
- Videos play on the PC's main screen in the default player. Volume, seeking and full-screen are done on the PC. The play/stop keys work with players that respond to the Windows media keys (Movies & TV, Windows Media Player, VLC and most others).
- A lecture with no commands for `idleMinutes` (default 120) is ended automatically. Raise it if you play videos longer than two hours.

## AV help requests
- Faculty press **Request AV help** on their console, choose the problem (projector, sound, PC, slides won't open, other) and add details. The request carries their name and room automatically. A room can have one open request at a time.
- It appears at once on the **Help requests** tab of every admin and AV dashboard (with a count badge, a pop-up alert, and a "Needs help" flag on the room's live monitor tile).
- **An email is sent automatically** to the AV recipients. Each request shows whether the email was sent, failed (with the reason) or is not set up.
- AV staff **add comments** (the faculty member sees them live and can reply with a note) and press **Resolve**, with an optional closing note. Resolved requests stay in the list and can be reopened.
- Set up the email once: admin opens **Settings**, enters the college SMTP server, the sender and the recipient addresses, then presses **Send test email**. If sending fails with a certificate error on an internal mail server, tick the "Trust the mail server's certificate" box.
- Requests, comments and resolutions are kept in `data/help.json` and also written to the Activity log.

## Server (one machine on the college LAN)
1. Install Node.js 18+. In this folder run `npm install`, then `npm start`.
2. Open `http://SERVER_IP:3000` (the address is printed on start).
3. First-run accounts: `admin / admin123`, `av1 / av123`, `av2 / av123`, `teacher1 / teach123`. **Each must set a new password (8+ characters) at first sign-in.**
4. Sign in as admin or AV, open **Lecture rooms**, and add every LR with its name and floor. Each gets its own Agent ID.
   Each LR PC needs its own network address. PCs that share one address through NAT cannot be told apart.

## Each lecture room PC (Windows, PowerPoint installed)
1. On **Lecture rooms**, press **Installer** on that room's row, copy the `.bat` file to the PC and double-click it.
   It needs Python 3.10+ and internet access once. It installs the agent with that room's Agent ID, starts it at every sign-in, and adds a **Lecture Room Login** shortcut to the desktop.
2. Faculty open that shortcut, sign in, and drop in a PowerPoint or PDF. It presents at once. Saved lectures can be started again with **Present**.
3. For the best result use two displays: the PC monitor shows the control page and the projector (extended display) shows the slides.

To remove the agent: delete `MCSCMS-Agent.vbs` from the Startup folder (Win+R, `shell:startup`) and end `pythonw.exe` in Task Manager.

## Full access with VNC (new)
Full access to the room PC now uses **TightVNC** (a Windows service) shown in the browser with **noVNC**. Unlike the agent, a service can reach the login screen, lock screen and UAC prompts. The old agent-based remote control stays as the automatic fallback for rooms where VNC is not installed.
1. On the server run `npm install` (it brings noVNC). Download the **64-bit TightVNC .msi** from tightvnc.com and save it as `agent/vnc/tightvnc.msi`.
2. On **Lecture rooms** press **VNC** on a room's row, copy the `.bat` to that PC and run it (it asks for administrator rights). It installs TightVNC as a service with that room's own password and opens port 5900 in Windows Firewall **only for the server's address(es)**. Set `MCSCMS_VNC_ALLOW=ip1,ip2` on the server to name the allowed addresses yourself. Port: `vncPort` in `data/config.json`.
3. After a few seconds the button shows **VNC ✓**. Teachers (on their own device) and AV/admin press **Full access** as before; the room then opens through VNC.
- The browser never connects to the PC directly. It gets a one-time ticket (30 s) only after the same checks as before (teacher: own room only; AV/admin: Take control first). The server relays the link, ends it when control is released, taken over, or the browser closes, and writes start and end (duration, bytes) to the Activity log.
- **"TightVNC refused the sign-in" came back?** Run the room's VNC installer again (it can be run any number of times): if TightVNC is already there it only re-writes the password and port in the registry and restarts the service, which also clears TightVNC's temporary block after repeated wrong passwords. While a room's VNC sign-in is failing, the server automatically uses the older agent remote control for it (for 5 minutes, then VNC is tried again), and the Activity log shows what TightVNC actually answered.
- **Saved passwords:** once a VNC sign-in works, the server remembers that password for the room in `data/rooms.json` and tries it first next time, then the `vncPassword` of `data/config.json`, then the generated one. A refused password moves to the next one on the next press of Full access.
- **TightVNC already installed by hand?** Skip the VNC installer. Put that password in `data/config.json` as `"vncPassword": "yourpass"` (used for every room) and restart the server. The first 8 characters count.
- The room's VNC password is stored in `data/rooms.json`, is handed to the browser only inside that start message, and the firewall rule keeps other computers from using it. Traffic is plain RFB on the LAN, like the rest of MCSCMS.
- Known limits: the Windows key is hidden from faculty in the key tray but not blocked at the server; with two displays TightVNC shows all displays unless you choose one in its settings (Server, Display).

## Logo and system name
Sign in as admin, open **Settings > Branding**. Upload a PNG, JPG or WebP logo (up to 2 MB) and type the system name (suggestions are offered). They show on the sign-in screen, the side bar, the faculty header and the browser tab. The logo is stored as `data/logo.png|jpg|webp` and the name as `systemName` in `data/config.json`. **Remove logo** brings back the default icon.

## Settings (`data/config.json`)
| Setting | Default | Meaning |
|---|---|---|
| `idleMinutes` | 120 | End a lecture after this long without any command |
| `teacherIdleMinutes` | 45 | Sign faculty out after this long idle (not while presenting) |
| `disconnectGraceMinutes` | 3 | Keep a login this long after the browser closes |
| `staffIdleHours` | 12 | Sign staff out after this long idle |
| `maxUploadMB` | 2048 | Largest lecture file that can be uploaded |
| `allowFacultyControl` | true | Let a faculty member on their own phone or laptop use the mouse and keyboard of their room PC (Remote control). Admin and AV can always, after Take control |
| `allowFacultyTransfer` | true | Let faculty send files to their room PC (File transfer). Admin and AV always can |
| `transferMaxMB` | 500 | Largest file for File transfer |
| `transferFolders` | Lectures, Handouts, Media, Other | The only folders files can be sent to |
| `allowRemoteFaculty` | true | Let faculty sign in from phones and personal laptops and choose a room. Set `false` to allow faculty sign-in on LR PCs only |
| `agentPingSeconds` | 15 | The server pings each agent this often. A PC that stops answering is shown Offline within about two pings (minimum 5) |
| `mail` | (empty) | Email settings. Managed from the Settings tab, so you normally do not edit this by hand |

## Room shows Offline although the agent is running
The agent now (a) keeps its connection when the screen cannot be captured (locked PC, display off, remote desktop closed), (b) ignores the Windows proxy for the college LAN, (c) writes `agent.log` and (d) the server shows *why* a room is offline. Check in this order:
1. **Lecture rooms** tab: an Offline room shows *last seen* and, if the server refused the agent, the reason (for example *address already used by LR-2*: two PCs behind one NAT address, or one PC installed with two rooms' installers). **Activity log** also records refusals.
2. On the LR PC run `python %LOCALAPPDATA%\MCSCMS\agent.py --check`. It tests the settings, components, server reachability (without a proxy), screen capture, PowerPoint and whether the server accepts the agent, and prints `OK` or `FAIL` for each. The installer runs this test automatically.
3. Read `%LOCALAPPDATA%\MCSCMS\agent.log` on the LR PC.
4. If the installer was downloaded while the dashboard was open as `localhost`, older versions put `localhost` into it, so the agent looked for the server on its own PC. The server now substitutes its LAN address. To force a specific address (for example a DNS name), start the server with `MCSCMS_PUBLIC_HOST=lr-server.college.edu.pk:3000`.
After updating the server, re-run each room's **Installer** once so the PCs get the new agent.

## Security notes
- Passwords are salted scrypt hashes. Old accounts are upgraded automatically at their next sign-in.
- Six wrong passwords from one address pause sign-in from it for 2 minutes.
- Every sign-in, refusal, release, upload and presentation command is written to `data/audit.log` (Activity log tab).
- Remote faculty logins are not tied to a network address (phones change networks). They are protected by the account password and the session token, can only act on the one room they chose, and are marked in **Sign-ins** so AV staff can release them.
- Traffic is plain HTTP/WebSocket: use it only on the college LAN, or put HTTPS in front.
- The mail password is stored as plain text in `data/config.json`. Use a dedicated mailbox, and keep the folder private.
- Keep the `data` folder: it holds accounts, per-room Agent IDs, lectures and logs. Set `MCSCMS_DATA` to store it elsewhere.

## Known limits
Full screen on video, audio, PDF and other non-slide files depends on the PC's default app (PowerPoint slide shows are reliable). The agent also needs the PC's desktop to be unlocked, because Windows does not let programs bring windows to the front on a locked screen. Data is kept in JSON files, not MySQL. PDFs, documents and images open on the PC but cannot be paged remotely; video and audio support play/pause and stop; PPT, PPTX, PPS and PPSX support next, previous, blank and stop. After updating, re-run each room's Installer so the PCs get the new agent.
