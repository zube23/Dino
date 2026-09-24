# shorts-factory

Potpuno automatizirana tvornica YouTube Shortsa: smiješni skečevi s
dinosaurom kojem ništa u modernom svijetu nije dizajnirano za ruke.
Sve se generira kodom — animacija, glas, titlovi, glazba i zvučni efekti —
bez plaćenih servisa i bez tuđeg materijala.

## Kako radi

```
queue/scripts/NNN-ime.json     skeč (beatovi: tekst, poza, scena, efekti)
        │
        ▼  factory/timeline.py  — Piper TTS po liniji → točna vremena
        ▼  factory/audio.py     — sintetizirana glazba + SFX + miks (numpy)
        ▼  factory/render.py    — renderer/stage.html u Chromiumu,
        │                         frame-po-frame (čista funkcija vremena)
        ▼  ffmpeg               — 1080×1920 @ 30fps, loudnorm −14 LUFS
        ▼  factory/upload.py    — YouTube Data API v3 (kategorija Comedy,
        │                         selfDeclaredMadeForKids: false)
        ▼  queue/state.json     — što je objavljeno
```

`.github/workflows/shorts-daily.yml` pokreće `factory/daily.py` svaki dan u
16:43 UTC: uzme prvi neobjavljeni skeč, izgradi ga i objavi. Kad se red
isprazni, workflow samo javi "queue is empty" — treba dopisati nove skečeve.

## Komande

```bash
pip install -r requirements.txt
python -m playwright install chromium   # ako Chromium nije već prisutan

python -m factory.build 001-coffee-shelf     # izgradi jedan video u out/
python -m factory.daily --no-upload          # sljedeći iz reda, bez objave
python -m factory.daily                      # izgradi + objavi (treba YT_OAUTH_JSON)
python -m factory.get_token ID SECRET        # jednokratna autorizacija (SETUP.md)
```

Glasovni model (~130 MB) se automatski skine s GitHuba pri prvom pokretanju
(nije u repou; u CI-ju se kešira).

## Kako napisati novi skeč

Dodaj `queue/scripts/NNN-kratko-ime.json` (NNN određuje redoslijed objave):

```json
{
  "id": "013-primjer",
  "title": "Naslov na YouTubeu (max 100 znakova)",
  "description": "Jedna-dvije rečenice.",
  "tags": ["dinosaur", "animation", "comedy"],
  "beats": [
    { "bg": "kitchen", "props": ["jar"], "top": "DAY 1",
      "say": "Izgovoreni tekst.", "mood": "tired", "action": "walkin" },
    { "caption": "*samo titl, bez govora*", "mood": "strain",
      "action": "reach", "dur": 1.8, "fx": ["sweat"] },
    { "bg": "void", "props": [], "say": "Poanta.", "mood": "deadpan",
      "action": "stare", "punch": true }
  ]
}
```

Polja beata:

| polje    | značenje |
|----------|----------|
| `say`    | izgovorena linija (postaje i titl); trajanje = stvarni govor |
| `caption`| titl bez govora (`*...*` = žuti "sfx" stil); traje `dur` s |
| `dur`    | trajanje beata bez govora (default 1.2) / `pause` nakon govora |
| `mood`   | neutral, deadpan, tired, focused, strain, shock, happy, smug, sad, angry, sleepy |
| `action` | idle, walkin, sadwalk, point, reach, stare, hop, nod, shake_no, panic, typing, flex, lookup, slump, celebrate, eat, smash |
| `bg`     | kitchen, office, gym, bedroom, livingroom, street, party, void (ostaje dok se ne promijeni) |
| `props`  | shelf_mug, dumbbell, router, alarm, cake, plant, jar, desk, hat, phone |
| `fx`     | confetti, sweat, zzz, impact, stars, q_mark, e_mark, photo_nostril, flash, wind |
| `punch`  | true = zoom + "ding" na poanti (obično uz `bg: "void"`) |
| `top`    | mala pločica gore ("DAY 4", "3 HOURS LATER") |
| `sfx`    | ručni zvuk: ding, boing, whoosh, thud, pop, gulp, creak, keys, alarm, party, shutter, wind |
| `ring` / `hatFly` / `pupDX` | budilica zvoni / šešir leti / pomak zjenica |

Recept koji radi: hook u prvoj sekundi → 2-3 eskalacije → rez na `void` +
`punch` za poantu → kratki tag. Ukupno 15–25 s.

## Podešavanje

- **Vrijeme objave:** cron u `.github/workflows/shorts-daily.yml` (UTC).
- **Glas:** `factory/config.py` → `SPEAKER_ID` (LibriTTS model ima 904
  govornika; 451 = dubok deadpan), `LENGTH_SCALE` (veće = sporije).
- **Izgled lika/scena:** sve je u `renderer/stage.html` (SVG + čisti JS,
  deterministična funkcija vremena — nema nasumičnosti između rendera).

## Licence

- Glas: Piper TTS, model LibriTTS — **CC BY 4.0** (atribucija se automatski
  dodaje u opis svakog videa iz `factory/config.py`).
- Font titlova: Baloo 2 — **SIL OFL** (`assets/fonts/LICENSE-baloo-OFL.txt`).
- Glazba i SFX: sintetizirani u `factory/audio.py` — bez vanjskih uzoraka.
- Sav vizualni sadržaj: originalan, generiran u `renderer/stage.html`.
