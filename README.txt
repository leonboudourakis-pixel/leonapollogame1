TIDEBREAK  ·  up to 4 players + bots  ·  same Wi-Fi OR over the internet
=======================================================================

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
  Up to 4 people can join the same host with the same code.
  The HOST picks the match in the menu (the others see what was picked):
    Match:     Free for all, or Teams (Poseidon vs Ares, humans split evenly)
    Bots:      0 to 6 computer soldiers, each one looks different
    Bot skill: Recruit, Regular or Veteran
  Changing a setting restarts the match for everyone.
  Free for all: first to 10 kills wins.  Teams: first team to 20 wins.
  A new match starts 10 seconds later.
  Every minute or two a navy helicopter comes in low and drops a rope.
  Walk up to it and press E to grab on; it flies you to another part of the
  island and drops you off (press E to let go early, but mind the fall).
  Playing alone or offline: Deploy gives a practice match against bots.
  Keep the host's Terminal window open while you play. Ctrl+C stops it.

IF SOMETHING GOES WRONG
  "No match found": check the code spelling, and that the host's Terminal window is open.
  The host's menu says internet play is not available: quit Terminal and start again.
  Laggy online: choose Fast graphics, pause big downloads / video calls on both ends.
  The game goes through Cloudflare's free tunnel, so no router or port settings are needed.

CONTROLS
  WASD move · Mouse aim · Left click fire · Right click aim down sights
  Shift sprint · C crouch (slide while sprinting) · Space jump, or vault a low wall
  R reload · E grab/let go of the rope
  1 machine gun · 2 sniper rifle · 3 shotgun · 4 sidearm · 5 supply-drop launcher · Q last weapon
  F infrared sensor (short bursts) · G frag grenade · X flashbang
  Enter or T text chat · Tab scoreboard · Esc menu

EXTRAS
  Change the kill target:  KILLS=15 node server.js     Change the port:  PORT=9000 node server.js
  Wi-Fi only (no internet code):  ONLINE=0 node server.js

Needs Node.js 18 or newer on the host Mac only (https://nodejs.org). The joiner needs just a browser.
