#!/bin/bash
# Starts a test pack under Xvfb and checks it comes up: the embedded server has run its
# start-up chain, and a window is on screen. Windows only show once their page has painted
# (`show: false`, `ready-to-show`), so a viewable window is a loaded page.
#
#   npm run pack:test
#   bash scripts/linux-smoke.sh release/linux-unpacked/bulwark
#
# A test pack, since production refuses --user-data-dir and --no-sandbox and restarts
# itself without them (src/main/switch-guard.ts).
#
# Needs xvfb, dbus-x11, gnome-keyring, x11-utils. A keyring has to run, since the app
# refuses to keep its keys in plain text. SMOKE_NO_SANDBOX=1 where Chromium's sandbox
# can't start, such as a container. SMOKE_SCREENSHOT=<file.png> with imagemagick keeps a
# picture. Exits 0 only if everything showed up.

set -u
binary="$1"
shift
work="$(mktemp -d)"
profile="$work/profile"
mkdir -p "$profile"
printf '{"mode":"standalone"}' > "$profile/shell-state.json"

display=":$((90 + RANDOM % 9))"
Xvfb "$display" -screen 0 1280x800x24 >/dev/null 2>&1 &
xvfb_pid=$!
export DISPLAY="$display"
sleep 1

# A throwaway session bus and an unlocked keyring, as a desktop session has.
eval "$(dbus-launch --sh-syntax)"
eval "$(printf 'smoke\n' | gnome-keyring-daemon --unlock --components=secrets 2>/dev/null)"
export XDG_CURRENT_DESKTOP=GNOME

# The app's own windows, by WM_CLASS and size. Not by title: the page sets it, and it
# says which screen is open ("Bulwark", "Sign in - Bulwark", "Mail - Bulwark"). Chromium
# keeps a few pixel-sized helper windows of the same class; a window has room for a page.
app_windows() {
  xwininfo -root -tree 2>/dev/null | awk '/\("[Bb]ulwark" / {
    for (i = 2; i <= NF; i++) if ($i ~ /^[0-9]+x[0-9]+[+-]/) {
      split($i, size, /[x+-]/)
      if (size[1] >= 300 && size[2] >= 300) print $1
      break
    }
  }'
}

no_sandbox=()
if [ "${SMOKE_NO_SANDBOX:-}" = "1" ]; then no_sandbox=(--no-sandbox); fi

"$binary" "$@" "${no_sandbox[@]}" --user-data-dir="$profile" --lang=en-US > "$work/app.log" 2>&1 &
app_pid=$!

ok=1
for _ in $(seq 1 90); do
  sleep 2
  kill -0 "$app_pid" 2>/dev/null || break
  [ -f "$profile/webmail/admin/admin.json" ] || continue
  for id in $(app_windows); do
    if xwininfo -id "$id" 2>/dev/null | grep -q IsViewable; then
      window="$id"
      ok=0
    fi
  done
  [ "$ok" = "0" ] && break
done

if [ "$ok" = "0" ]; then
  sleep 5
  echo "[smoke] window: $(xwininfo -id "$window" | grep 'xwininfo: Window id' | cut -c1-120)"
  echo "[smoke] class: $(xprop -id "$window" WM_CLASS 2>/dev/null)"
  if [ -n "${SMOKE_SCREENSHOT:-}" ]; then
    import -display "$display" -window root "$SMOKE_SCREENSHOT" 2>/dev/null || echo "[smoke] no screenshot"
  fi
else
  echo "[smoke] the app did not come up. Log:"
  tail -40 "$work/app.log"
  xwininfo -root -tree 2>/dev/null | head -20
  ls -la "$profile" "$profile/webmail" "$profile/logs" 2>/dev/null
  tail -20 "$profile/logs/server.log" 2>/dev/null
fi

kill "$app_pid" 2>/dev/null
sleep 2
kill -9 "$app_pid" 2>/dev/null
kill "$xvfb_pid" 2>/dev/null
kill "$DBUS_SESSION_BUS_PID" 2>/dev/null
pkill -f gnome-keyring-daemon 2>/dev/null
rm -rf "$work"
exit "$ok"
