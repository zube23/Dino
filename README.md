# DinoNest

Brzi offline nesting program za laserski rez. Ubacite DXF partove, zadajte
prioritete, upišite dimenzije ploče i kliknite **GENERIRAJ** — program u
djeliću sekunde posloži partove na ploču, spremi gotov DXF i odmah ga otvori
u SciCut-u (ili zadanoj aplikaciji za DXF).

- **Radi potpuno offline** — sve se sprema lokalno na računalu.
- **Prioriteti**: partovi s prioritetom 1 slažu se prvi; manji "popuna"
  partovi automatski pune ostatak ploče.
- **Rotacija da, zrcaljenje ne**: partovi se smiju rotirati (uključujući
  automatsko zakretanje u najuži položaj), ali se **nikad ne zrcale** —
  to je onemogućeno u samoj jezgri programa.
- **Povijest ploča**: svaka generirana ploča se pamti; kad upišete dimenzije
  koje ste već rezali, program odmah ponudi prijašnji DXF.

## Dva ekrana

| STROJ | PRIPREMA |
|---|---|
| Samo tri stvari: **duljina**, **širina** i veliki gumb **GENERIRAJ**. Za računalo pored lasera. | Ubacivanje DXF partova (povuci-i-pusti), prioriteti, broj komada ili "popuna", postavke i povijest. Za pripremu na laptopu. |

## Kako se koristi

1. Na ekranu **PRIPREMA** povucite svoje DXF partove u program.
2. Svakom partu zadajte:
   - **Prioritet** (1 = slaže se prvi),
   - **Način**: *Točan broj* (npr. točno 4 komada) ili *Popuna*
     (puni ostatak ploče, opcionalno s maksimumom),
   - **Uključen**: partovi koji su uvijek u igri ostave se uključeni.
3. U **Postavkama** upišite razmak između partova, rub ploče i putanju do
   SciCut programa (npr. `C:\SciCut\SciCut.exe`).
4. Na ekranu **STROJ** upišite izmjerenu duljinu i širinu ploče i kliknite
   **GENERIRAJ**. DXF se sprema i otvara automatski.

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
  nesting je u `src/core/` (čisti JavaScript, upotrebljiv i u web verziji).
- **DXF ulaz**: LINE, ARC, CIRCLE, LWPOLYLINE, POLYLINE, SPLINE, ELLIPSE,
  POINT, INSERT/BLOCK (jednoliko, nezrcalno skaliranje). ASCII DXF.
- **DXF izlaz**: R12 (AC1009) radi maksimalne kompatibilnosti sa CAM
  programima; splajnovi i elipse se pretvaraju u fine polilinije, lukovi i
  kružnice ostaju pravi lukovi. Milimetri.
- **Nesting**: MaxRects (Best-Short-Side-Fit) po najužem opisanom
  pravokutniku parta; part se prije slaganja automatski zarotira u
  orijentaciju s najmanjom površinom okvira, na ploči se dodatno smije
  rotirati za 90°. Sve transformacije su kruta rotacija + pomak
  (zrcaljenje matematički nije moguće).
- Podaci (partovi, postavke, povijest) žive u korisničkoj mapi aplikacije
  (`%APPDATA%/DinoNest`), generirani DXF-ovi po zadanome u
  `%APPDATA%/DinoNest/output` ili u mapi koju odaberete.
