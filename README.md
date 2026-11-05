# Slim verwarmen voor Homey

Een Homey Pro-app die je thermostaat een slim weekschema geeft, **zonder abonnement**. Gemaakt voor de **tado X** via Matter, maar het werkt met elke thermostaat in Homey die `target_temperature` en `measure_temperature` heeft.

- **Weekschema** met tijdsblokken per dag. Je stelt het in op de instellingenpagina van de app, in dezelfde stijl als tado.
- **Handmatig gaat voor.** Draait iemand aan de thermostaat, of past iemand de temperatuur aan in de tado-app of in Homey? Dan blijft die stand staan tot het volgende moment in het schema. Daarna neemt het schema het weer over.
- **Op tijd warm.** Bij elk opwarmmoment leert de app hoe snel het huis warm wordt (°C per uur) en hoe lang de cv nodig heeft om op gang te komen, ook in relatie tot de buitentemperatuur. Hij begint zo vroeg dat het op het ingestelde tijdstip al warm is.
- **Thuis/afwezig** via flowkaarten. Afwezig = eco-temperatuur (standaard 16°).
- **Widget** voor het Home-scherm, met de temperatuur, knoppen − en + en de balk van vandaag.
- **Klimaat-apparaat** "Slim verwarmen": het schema is zichtbaar in het Klimaat-overzicht van Homey.

## Installeren

Je hebt een Homey Pro nodig (firmware 12.1 of nieuwer) en een computer met Node.js 24 of nieuwer, in hetzelfde netwerk als de Homey.

```bash
git clone https://github.com/leroysileon/homey-slim-verwarmen.git
cd homey-slim-verwarmen
npm install
npx homey login
npx homey app install
```

Na installatie:

1. Open **Apps → Slim verwarmen → Instellingen**. Controleer of de juiste thermostaat en buitentemperatuur gekozen zijn; de app probeert die zelf te vinden (bijvoorbeeld de KNMI-app). Zet daarna je weekschema erin.
2. Zet andere schema-apps of flows die dezelfde thermostaat aansturen uit.
3. Maak een flow voor aanwezigheid: *Laatste persoon vertrekt* → **Iedereen is afwezig**, en *Eerste persoon komt thuis* → **Iedereen is thuis**.
4. Optioneel: voeg het apparaat **Slim verwarmen** toe (voor het Klimaat-overzicht) en de widget **Verwarming** (voor het Home-scherm).

## Flowkaarten

| Soort | Kaart |
|---|---|
| Actie | Iedereen is [thuis/afwezig] · Hervat schema · Zet [temp]° voor [uren] uur · Zet slim verwarmen [aan/uit] |
| Voorwaarde | Handmatige stand is actief · Is aan het voorverwarmen |
| Trigger | Thermostaat is handmatig versteld (temp, tot) · Terug naar het schema · Schema heeft temperatuur aangepast · Geleerd van een opwarmmoment |

## Zo werkt het leren

- Een meting start zodra de ingestelde temperatuur minstens 1° boven de kamertemperatuur ligt.
- **Opstarttijd**: de tijd tot de kamer 0,2° warmer is geworden.
- **Opwarmsnelheid**: de stijging per uur vanaf dat moment, tot de doeltemperatuur bereikt is.
- Na 6 metingen met minstens 4° verschil in buitentemperatuur rekent de app ook met de buitentemperatuur (kouder = trager).
- Voorverwarmtijd = opstarttijd + (verschil ÷ snelheid), plus 10% marge, met een instelbaar maximum (standaard 3 uur).
- Tot er metingen zijn, gaat de app uit van 1 °C per uur en 15 minuten opstarttijd.

## Ontwikkelen

```bash
npm test                 # unittests van schema, leren en handmatig verstellen
node dev/preview.js      # instellingenpagina en widget met een nep-Homey, op http://localhost:4321
```

De kernlogica staat in `lib/` en bevat geen Homey-code, zodat hij los te testen is. `app.js` koppelt die logica aan Homey.

**Let op met tado:** de tado X heeft een eigen schema. Druk in de tado-app niet op "Schema hervatten", want dan zet tado zijn eigen temperatuur terug en ziet deze app dat als handmatig verstellen. Gebruik "Schema hervatten" in Homey.

---

## Uitleg voor huisgenoten

> **Je hoeft niets anders te doen dan vroeger.**
>
> - Te koud of te warm? **Draai gewoon aan de thermostaat.**
> - Die temperatuur blijft staan tot het volgende vaste moment, bijvoorbeeld 's avonds of 's ochtends.
>   Daarna gaat hij vanzelf terug naar het normale schema.
> - 's Ochtends is het op tijd warm, want het huis begint zelf eerder met verwarmen.
> - Iedereen weg? Dan gaat de verwarming vanzelf lager. Komt iemand thuis, dan gaat hij weer omhoog.
