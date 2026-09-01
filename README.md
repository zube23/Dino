# DinoNest

Brzi offline nesting program za laserski rez. Ubacite DXF partove, zadajte
prioritete, upišite dimenzije ploče i kliknite **GENERIRAJ** — program u
djeliću sekunde posloži partove na ploču i odmah je otvori u CypCut-u (ili
zadanoj aplikaciji za DXF).

- **Radi potpuno offline** — sve se sprema lokalno na računalu.
- **Uski prozor**: program radi i kao uska kolona (od ~360 px) uz CypCut;
  veličina i položaj prozora se pamte.
- **Drag & drop u CypCut**: karticu generirane ploče povučete mišem ravno
  u CypCut — bez otvaranja mapa i traženja datoteka.
- **Bez gomilanja datoteka**: ploče se pamte kao mali zapis (koji part gdje
  leži); DXF se stvori u hodu tek kad ga otvorite/povučete i automatski se
  čisti. "Spremi DXF…" postoji za trajnu kopiju.
- **Ponude sličnih dimenzija**: upišete npr. 600×250 i vidite karticu nove
  ploče i svih starih unutar tolerancije (zadano ±20 mm, podesivo) — i
  zarotiranih (240×590). Povučete koju želite.
- **Prioriteti**: partovi s prioritetom 1 slažu se prvi; manji "popuna"
  partovi automatski pune ostatak ploče.
- **Rotacija da, zrcaljenje ne**: partovi se smiju rotirati (uključujući
  automatsko zakretanje u najuži položaj), ali se **nikad ne zrcale** —
  to je onemogućeno u samoj jezgri programa.

## Dva ekrana

| STROJ | PRIPREMA |
|---|---|
| **Duljina**, **širina**, veliki **GENERIRAJ** i kartice ponuđenih ploča koje se povlače u CypCut. | Ubacivanje DXF partova (povuci-i-pusti), prioriteti, broj komada ili "popuna", postavke i povijest. |

## Kako se koristi

1. Na ekranu **PRIPREMA** povucite svoje DXF partove u program. Klik na
   sličicu parta otvara veliki pregled — odmah se vidi je li uvoz točan.
2. Svakom partu zadajte:
   - **Prioritet** (1 = slaže se prvi),
   - **Način**: *Točan broj* (npr. točno 4 komada) ili *Popuna*
     (puni ostatak ploče, opcionalno s maksimumom),
   - **Uključen**: partovi koji su uvijek u igri ostave se uključeni.
3. U **Postavkama** upišite razmak između partova, rub ploče i putanju do
   CypCut programa (npr. `C:\Program Files\Friendess\CypCut\CypCut.exe`).
4. Na ekranu **STROJ** upišite izmjerenu duljinu i širinu ploče i kliknite
   **GENERIRAJ** — ili samo pogledajte ponuđene stare ploče istih (±20 mm)
   dimenzija. Karticu ploče povucite mišem u CypCut, ili dvokliknite.

U mapi `samples/` je šest probnih partova za isprobavanje.

## Instalacija na računalo lasera (Windows)

Najlakše: preuzmite **DinoNest-Setup-*.exe** (installer) ili
**DinoNest-Portable-*.exe** (bez instalacije), prebacite na USB i pokrenite
na računalu lasera. Instalacija ne treba internet.

### Gdje se preuzima .exe

Na GitHubu, u kartici **Actions → Build Windows installer → Run workflow**:
build se izvrti automatski i artefakt `DinoNest-Windows` sadrži oba .exe-a.
Isto se dogodi automatski kod svake objave taga `v*` (npr. `v1.0.0`).

### Ručni build (na bilo kojem Windows računalu s Node.js-om)

```bat
npm install
npm test
npm run dist
```

Rezultat je u mapi `dist/`: `DinoNest-Setup-<verzija>.exe` i
`DinoNest-Portable-<verzija>.exe`.

## Pokretanje u razvoju

```bat
npm install
npm start
```

Testovi jezgre (ne trebaju Electron): `npm test`

## Tehnički detalji

- Electron aplikacija bez vanjskih runtime ovisnosti; sav kod za DXF i
  nesting je u `src/core/` (čisti JavaScript, upotrebljiv i u web verziji —
  `node scripts/build-web.js` složi `web/dinonest-web.html`).
- **DXF ulaz**: LINE, ARC, CIRCLE, LWPOLYLINE, POLYLINE, SPLINE (i samo s
  fit točkama), ELLIPSE, INSERT/BLOCK (jednoliko, nezrcalno skaliranje),
  ekstruzija (OCS), geometrija skrivena u blokovima, automatska pretvorba
  mjernih jedinica (inč/cm/m → mm). ASCII DXF.
- **DXF izlaz**: R12 (AC1009) radi maksimalne kompatibilnosti sa CAM
  programima; splajnovi i elipse se pretvaraju u fine polilinije, lukovi i
  kružnice ostaju pravi lukovi. Milimetri.
- **Nesting**: MaxRects (Best-Short-Side-Fit) po najužem opisanom
  pravokutniku parta; part se prije slaganja automatski zarotira u
  orijentaciju s najmanjom površinom okvira, na ploči se dodatno smije
  rotirati za 90°. Sve transformacije su kruta rotacija + pomak
  (zrcaljenje matematički nije moguće).
- **Pohrana**: partovi, postavke i povijest žive u `%APPDATA%/DinoNest`.
  Povijest ploča čuva samo raspored (nekoliko KB po ploči); DXF datoteka
  se stvara na zahtjev u privremenoj mapi i briše nakon tjedan dana.
