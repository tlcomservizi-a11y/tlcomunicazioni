# tlcomunicazioni

## Modulo di contatto e proxy CRM

Il sito include un modulo di contatto (`index.html`) che invia i lead a un
proxy server (`server/`), il quale li inoltra al CRM. Il token API del CRM
resta configurato solo lato server e non viene mai esposto al browser.

### Avvio in locale

```bash
cd server
npm install
cp .env.example .env   # poi inserire CRM_API_URL e CRM_API_TOKEN reali
npm start
```

Il server sarà disponibile su `http://localhost:3000`, e servirà sia il sito
statico che l'endpoint `POST /api/leads` usato dal modulo.
