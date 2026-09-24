# SETUP — jednokratno povezivanje s YouTubeom (~20 min)

Nakon ovih koraka **sve radi samo**: GitHub svaki dan u 18:43 renderira sljedeći
skeč iz reda čekanja i objavi ga na kanal. Nitko ništa ne dira.

Ovo su jedini koraci koje robot ne može odraditi umjesto tebe, jer traže
prijavu u tvoj Google račun. Redoslijed je bitan.

## 1. Google račun (preskoči ako već imaš račun za kanal)

1. Otvori https://accounts.google.com/signup
2. Izradi račun (ime po želji — može i ime kanala), dodaj broj mobitela za
   potvrdu i oporavak.

## 2. YouTube kanal

1. Prijavljen tim računom otvori https://www.youtube.com
2. Klik na avatar (gore desno) → **Create a channel** → upiši ime kanala →
   Create.

## 3. Google Cloud projekt + YouTube API

1. Otvori https://console.cloud.google.com (isti račun), prihvati uvjete.
2. Gore lijevo klikni izbornik projekata → **New project** → ime
   `shorts-factory` → Create → odaberi ga.
3. Izbornik ☰ → **APIs & Services** → **Library** → traži
   **YouTube Data API v3** → **Enable**.

## 4. OAuth suglasnost

1. **APIs & Services** → **OAuth consent screen** (novije sučelje: "Google
   Auth Platform" → Branding/Audience).
2. Tip **External** → App name `shorts-factory`, support i developer email =
   tvoja adresa → spremi (scopes preskoči, testne korisnike preskoči).
3. **VAŽNO:** na Audience/Publishing klikni **Publish app** (status mora biti
   **In production**). U statusu "Testing" pristup istekne svakih 7 dana i
   automatika bi stala.

## 5. OAuth klijent

1. **APIs & Services** → **Credentials** → **Create credentials** →
   **OAuth client ID**.
2. Application type: **TVs and Limited Input devices** → Create.
3. Prepiši **Client ID** i **Client secret**.

## 6. Token (autorizacija kanala)

Najlakše: pošalji Client ID i Client secret Claudeu u chat — on pokrene
autorizaciju i vrati ti gotov JSON. Dobit ćeš URL + kratki kod, otvoriš ga na
mobitelu, prijaviš se računom kanala i klikneš **Allow**. (Upozorenje "Google
hasn't verified this app" je normalno — to je tvoja vlastita aplikacija:
Advanced → continue.)

Ili sam, lokalno:

    cd shorts-factory
    pip install -r requirements.txt
    python -m factory.get_token CLIENT_ID CLIENT_SECRET

Rezultat je JSON oblika
`{"client_id": "...", "client_secret": "...", "refresh_token": "..."}`.

## 7. GitHub secret

1. Otvori https://github.com/zube23/Dino/settings/secrets/actions
2. **New repository secret** → Name: `YT_OAUTH_JSON` → Secret: zalijepi cijeli
   JSON iz koraka 6 → **Add secret**.

## 8. Uključivanje

- Ručni test odmah: GitHub → **Actions** → **Daily Short** → **Run workflow**
  (možeš prvo s uključenim *dry_run* — samo renderira, ne objavljuje).
- Automatski dnevni raspored radi tek kad je workflow na **main** grani —
  dakle nakon merge-a ove grane u main.

## Poznata ograničenja (pošteno rečeno)

- **Google audit:** novijim API projektima Google zna zaključati videe
  uploadane API-jem kao privatne dok ne ispuniš kratki obrazac
  (https://support.google.com/youtube/contact/yt_api_form — opiši da
  objavljuješ vlastite animirane videe na vlastiti kanal). Ako prvi upload
  završi kao "Private (locked)", to je to — ispuni obrazac, odobrenje obično
  stigne u nekoliko dana i od tada objave idu javno automatski.
- **Kvota:** 10.000 API jedinica dnevno; jedan upload troši 1.600 (max ~6
  videa/dan). Mi objavljujemo 1 dnevno.
- **Monetizacija:** prag za YouTube Partner Program je 1.000 pretplatnika +
  10 mil. pregleda Shortsa u 90 dana (ili 4.000 sati long-form). Prvi mjeseci
  su gradnja publike, ne zarada.
- **Nikad ne commitaj** `out/yt_oauth.json` ni bilo kakve ključeve u repo —
  ključ živi samo u GitHub Secrets.
