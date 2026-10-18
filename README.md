# Pacer Club · Heart Rate Booth

A full-screen booth page for the Health & Wellbeing Fair. Up to three people at
once, one heart rate armband each, on one shared countdown: sit still (20 s,
longer if heart rates are still settling), high knees to a 170 steps/min beat
(60 s), sit and recover (60 s). Then a head to head ranked by recovery, a full
report per person, and a printed receipt for each.

## Run it

```sh
python3 booth.py
```

Open http://localhost:8000 in **Chrome**. `booth.py` serves the page and does
the printing; it needs nothing installed. (Web Bluetooth needs Chrome and a
secure origin, and localhost counts as one.)

1. Put stickers 1, 2, 3 on the armbands. Press **Connect armband 1** on lane 1
   and pick that armband; the same for 2 and 3. Each lane shows its armband's
   name. An armband can only be on one lane.
2. Press **F** (or the corner button) for full screen.
3. **Next group** (or **N**) opens a form with a column per lane: name, house,
   age, and optionally max heart rate and a 1 km or 800 m time. Empty lanes sit
   it out, so one or two people work too.
4. **Start**. It stays greyed out, with a note saying why, until every named
   person has an armband with a live heart rate.

While a group is running you can already fill in **Next group** for the people
waiting. If one lane loses its signal, only that person gets "Signal lost, try
again"; the others finish normally, and that person is put back in the next
group in the same lane.

If an armband drops out, its lane keeps reconnecting on its own.

## Receipts

Each person who finishes gets a receipt, printed automatically in lane order
(turn that off with `···` → Print after each test). Reports have **Print
again**, and the head to head has **Print all again**.

The receipt is laid out as a web page 576 dots wide (the 72 mm an 80 mm thermal
printer can reach at 203 dpi), drawn to an image and reduced to 1-bit black and
white with dithering, exactly what a thermal head prints. `···` → Show receipt
previews it. Its QR code opens the person's result on pacer.club, where they can
sign up and save it to their profile.

Where it prints is one word in `printer.json`. It ships as `"off"`, so nothing
prints until you choose a printer. `booth.py` prints through macOS directly, with
no browser dialog, whatever browser the page is open in:

| `"printer"` | What happens |
|---|---|
| `"a4"` | Your normal printer, through macOS. The receipt is at true size on A4: an 80 mm outline of the paper, centered, with the 72 mm print inside, no headers or footers. `"queue"` picks a printer by name (`lpstat -p` lists them); empty means the default. The last one is also saved as `last-receipt.pdf`. |
| `"epson"` | The TM-T82III, sent the image as ESC/POS raster commands followed by a cut. No Mac driver involved. |
| `"off"` | No printing. |

No need to restart `booth.py` after changing it: the file is read on every print.

### When the Epson arrives

**Network (recommended).** Plug it into the same network as the laptop, or
straight into the laptop with an Ethernet cable. Hold the feed button while
turning it on to print its status sheet, which shows its IP address (with no
network to give it one, Epson printers fall back to `192.168.192.168`; give the
laptop's Ethernet a manual address like `192.168.192.10` to reach it). Then:

```json
"printer": "epson",
"epson": { "connection": "network", "host": "192.168.192.168", "port": 9100, "cut": "full" }
```

**USB.** macOS needs a print queue that passes bytes through untouched:

```sh
lpinfo -v | grep -i epson                     # find its usb:// address
lpadmin -p EPSON_TM_T82III_raw -E -v "usb://EPSON/TM-T82III?serial=…" -m raw
```

then `"connection": "usb"` and `"usbQueue": "EPSON_TM_T82III_raw"`. `"cut"` is
`"full"` or `"partial"`.

If the page is opened without `booth.py` (from a file, say), printing falls back
to Chrome's print dialog with the same A4 layout.

## Operator controls

The `···` menu in the top bar:

- **Demo armbands**: a pretend person on every lane without a real armband,
  for trying everything. **Drop a lane's signal 1 2 3** tests "signal lost".
- **Sound cues**: the step beat, plus beeps on each step and the last 3 seconds
- **Dark mode**
- **Print after each test**
- **Show receipt**: the 1-bit image for the report on screen
- **Download results**: CSV of everyone
- **Remove last result**: for a bad reading
- **Reset leaderboard**: click twice to confirm

Keys: **F** full screen · **N** next group · **L** leaderboard · **Esc** back.

## How the numbers are worked out

Measured by the armband:

- **Resting**: average of the last 12 s of sitting still. If heart rate is still
  clearly falling (more than ~3 bpm over those 12 s), rest runs on 5 s at a
  time, up to 20 s extra, until it settles.
- **Recovery** (scored): heart rate the moment high knees end, minus heart rate
  exactly 60 s later. In a group, rest runs on if anybody's heart rate is still
  settling, and everyone's resting is read over the same final 12 s. Both are read between the readings on either side of
  that moment. No weight or anything else is needed.
- **Peak**: highest reading from the start of high knees to the end. Shown, not scored.

Estimated:

- **Zones**: heart rate reserve (Karvonen, 50/60/70/80/90%) between measured
  resting and max. Max is what the person entered, or 208 − 0.7 × age (Tanaka),
  and the report says which.
- **Easy pace**: only with a real 1 km / 800 m time (Daniels' VDOT, easy at
  62–70%). Without one, the report shows their zone 2 range instead of a pace.

### Signal checks

A lane stops with "Signal lost, try again" (no report, nothing saved for that
person; everyone else carries on) if, during the test:

- the armband disconnects,
- no reading arrives for 5 s,
- the reading stays on one number for 15 s (25 s while resting), or
- it jumps more than 30 bpm between readings a second or two apart.

In demo mode, `···` → **Drop a lane's signal** tries this.

Results are saved in the browser's localStorage, so a page refresh keeps them.
Results from the first version (30 s high knees, different recovery rule) are
kept separately and don't appear on this leaderboard.
Clearing site data or using a different browser won't.

## Files

- `index.html`, `styles.css`, `app.js`: the booth
- `receipt.js`: the receipt layout, the 1-bit dithering, the result link in the QR
- `booth.py`, `printer.json`: the local server and where receipts print
- `vendor/qrcode.js`: QR generator (MIT, Kazuhiko Arase), local so it works offline
- `icon.svg`: favicon from pacer-club-v2

The result link format is documented in `receipt.js` (`encodeResult`) and
decoded by pacer.club in `pacer-club-v2/src/lib/booth-result.ts`; change both
together. `RESULT_URL` and `CLUB` at the top of `app.js` say where links point
and which club's houses sign-up should offer.
