# Ponte WhatsApp di TL Comunicazioni

Collega il WhatsApp Business del telefono (342 076 0052) all'assistente clienti di Partner Hub **con il QR code**, come WhatsApp Web: niente Meta Cloud API, niente partner esterni. Il telefono continua a funzionare normalmente.

```
Cliente ──WhatsApp──▶ telefono TL ◀──QR── Ponte (questo programma) ──▶ Partner Hub (assistente AI, ticket, lead)
                                                   ◀── risposta da inviare ──┘
```

- I messaggi dei clienti vanno a Partner Hub, che li registra, apre il ticket e decide se rispondere.
- Le risposte tornano al ponte, che le invia dal numero TL. Prima di inviare mostra "sta scrivendo…" per qualche secondo.
- Se rispondi tu dal telefono, Partner Hub lo sa e in quella chat l'assistente tace per 12 ore.
- Gruppi, stati e canali vengono ignorati. Il ponte non scrive mai per primo e ha un limite di sicurezza: al massimo 8 risposte per chat all'ora e 6 al minuto in tutto.
- Il ponte non serve una porta aperta su internet: chiama lui Partner Hub. Si può quindi installare su un PC in negozio.

> ⚠️ Il collegamento non ufficiale (tramite la libreria Baileys) non è autorizzato da WhatsApp: il numero può essere limitato o bloccato. I limiti qui sopra riducono il rischio, ma non lo eliminano.

## Dove farlo girare

Serve un computer **sempre acceso e collegato a internet**: un PC o mini-PC in negozio (Windows, Mac o Linux) oppure un piccolo server. Il telefono non deve restare acceso: dopo il collegamento il ponte lavora da solo, come WhatsApp Web, ma ogni 14 giorni circa il telefono deve connettersi almeno una volta.

### Con Docker (consigliato)

```bash
cd gateway
cp .env.example .env      # compila PANEL_PASSWORD e GATEWAY_SECRET
docker compose up -d --build
```

### Senza Docker (Node.js 20 o successivo)

```bash
cd gateway
npm ci
cp .env.example .env      # compila PANEL_PASSWORD e GATEWAY_SECRET
node --env-file=.env src/server.js
```

## Collegare il telefono

1. Sul computer del ponte apri `http://localhost:3100` e accedi con la password di `PANEL_PASSWORD` (il nome utente è indifferente).
2. Sul telefono: WhatsApp Business → ⋮ → **Dispositivi collegati** → **Collega un dispositivo**.
3. Inquadra il QR. Il pannello passa a **Collegato** e mostra il numero.

Per scollegare: pulsante **Scollega** nel pannello, oppure dal telefono in Dispositivi collegati.

## Accendere l'assistente

L'interruttore è in Partner Hub (segreti Base44):

| `WA_AI_ENABLED` | Effetto |
| --- | --- |
| vuoto | il ponte registra i messaggi e le risposte manuali, ma non risponde a nessuno |
| `test` | risponde l'assistente solo ai numeri in `WA_AI_TEST_NUMBERS` |
| `true` | risponde l'assistente a tutti (tranne alle chat dove hai scritto tu nelle ultime 12 ore) |

`WA_TRANSPORT=ponte` fa accettare a Partner Hub solo i messaggi firmati dal ponte con `TL_GATEWAY_SECRET`.

## Test

```bash
npm test
```
