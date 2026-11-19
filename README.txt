TIDEBREAK  ·  1v1 deathmatch  ·  same Wi-Fi OR over the internet
================================================================

HOST (one Mac, e.g. Dad's)
  1. Double-click "Start Tidebreak.command".
     First time only: if macOS says it can't be opened, right-click it > Open > Open.
     If it asks to allow incoming network connections for "node", click Allow.
  2. A Terminal window opens and the game opens in your browser.
     The first time, it downloads a small free helper for internet play
     (Cloudflare "cloudflared", about a 20 MB download). That takes a minute, once.
  3. The game menu shows a JOIN CODE, for example:   sunny-lake-river-boat
     Click "Copy invite" and text it to the other player.
     The code is new every time you start Tidebreak.

JOIN FROM ANOTHER HOUSE (no install, no setup)
  Either:  open the link from the invite in Chrome or Safari
           (https://sunny-lake-river-boat.trycloudflare.com)
  Or:      double-click "Join a Game.html" in the Tidebreak folder,
           type the join code, click Join.

JOIN ON THE SAME WI-FI
  Open the "Same Wi-Fi" link shown in the host's menu, e.g. http://192.168.1.23:8080
  (the join code works at home too).

PLAY
  Type a callsign, click Deploy, click into the game to capture the mouse.
  First to 10 kills wins. A new match starts 10 seconds later.
  Keep the host's Terminal window open while you play. Ctrl+C stops it.

IF SOMETHING GOES WRONG
  "No match found": check the code spelling, and that the host's Terminal window is open.
  The host's menu says internet play is not available: quit Terminal and start again.
  Laggy online: choose Fast graphics, pause big downloads / video calls on both ends.
  The game goes through Cloudflare's free tunnel, so no router or port settings are needed.

CONTROLS
  WASD move · Mouse aim · Left click fire · Right click aim down sights
  Shift sprint · C crouch · Space jump · R reload
  1 carbine · 2 marksman rifle (scope) · 3 sidearm · Q last weapon
  Tab scoreboard · Esc menu

EXTRAS
  Change the kill target:  KILLS=15 node server.js     Change the port:  PORT=9000 node server.js
  Wi-Fi only (no internet code):  ONLINE=0 node server.js

Needs Node.js 18 or newer on the host Mac only (https://nodejs.org). The joiner needs just a browser.
