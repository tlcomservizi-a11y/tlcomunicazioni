# TL Agenti

Un team di agenti IA per le piccole attività: rispondono ai clienti su WhatsApp e sul sito, fissano gli appuntamenti, tengono il CRM, preparano le pubblicità e propongono al titolare cosa fare ogni giorno. Il titolare li comanda dal telefono, anche a voce.

## Cosa c'è

| Parte | Dove | Stato |
| --- | --- | --- |
| Landing page | `public/index.html` (`/`) | ✅ |
| App del titolare, installabile (PWA) | `public/app/` (`/app`) | ✅ |
| **Agente Vendite**: risponde ai clienti, propone orari liberi, prenota, aggiorna il CRM, passa la chat al titolare | `src/agents/sales.ts` | ✅ |
| **Agente Manager** ("Chiedi a TL"): numeri, contatti, agenda, messaggi ai clienti, bozze di inserzioni, scheda attività | `src/agents/manager.ts` | ✅ |
| Proposte del giorno con "Fallo per me" | `generateProposals` / `executeProposal` | ✅ |
| WhatsApp Business Cloud API (webhook + invio) | `src/channels/whatsapp.ts` | ✅ (serve un numero Meta) |
| Chat per il sito (una riga di codice) | `public/widget.js` | ✅ |
| CRM contatti, agenda, account multi-attività | `src/db.ts`, `src/routes/api.ts` | ✅ |
| Comandi vocali (riconoscimento e lettura in italiano) | browser (Web Speech API) | ✅ Chrome/Safari |
| Pubblicazione automatica su Meta/Google Ads | — | 🔜 oggi le inserzioni sono bozze da approvare e copiare |
| Instagram/Messenger, promemoria appuntamenti, social, blog | — | 🔜 |

## Avvio

Requisiti: Node.js 22.13 o successivo.

```bash
npm install
cp .env.example .env     # inserisci ANTHROPIC_API_KEY
npm start          # oppure: npm run dev (si riavvia quando cambi il codice)
```

Poi apri `http://localhost:3000`, registra un'attività, compila **Altro → La tua attività** e prova l'assistente da **Altro → Prova l'assistente**.

## Collegare WhatsApp

1. Su [Meta for Developers](https://developers.facebook.com) crea un'app di tipo Business e aggiungi il prodotto WhatsApp.
2. Webhook: URL `https://TUO-DOMINIO/webhooks/whatsapp`, verify token uguale a `WHATSAPP_VERIFY_TOKEN`, campo `messages`.
3. Nell'app TL, in **Impostazioni**, inserisci il *Phone number ID* e il token permanente (utente di sistema).

Nota: con WhatsApp un'attività può scrivere liberamente solo entro 24 ore dall'ultimo messaggio del cliente. Oltre servono modelli di messaggio approvati da Meta, quindi i follow-up verso contatti fermi da più giorni possono essere rifiutati. L'errore viene mostrato nella proposta.

## Chat sul sito

In **Impostazioni** c'è lo snippet da incollare nel sito del cliente:

```html
<script src="https://TUO-DOMINIO/widget.js" data-tl="slug-attivita" async></script>
```

## Come lavorano gli agenti

- Usano l'API Claude tramite `@anthropic-ai/sdk` e il suo *tool runner*. Ogni tool è un'operazione sul database (slot liberi, prenotazione, CRM, bozze di inserzioni, proposte).
- Modello di default `claude-opus-5-5` (modificabile con `TL_MODEL`). L'agente Vendite lavora a effort `low` per rispondere in fretta, il Manager a `medium`.
- I fallback lato server sono attivi (`fallbacks: "default"`): se il modello rifiuta una richiesta, l'API la riprova su un modello di riserva. Se l'IA non è raggiungibile, il cliente riceve comunque una risposta di cortesia e la chat passa al titolare.
- Le istruzioni e la scheda dell'attività stanno nel prompt di sistema, che viene messo in cache. Data e ora vanno in coda all'ultimo messaggio.
- Consumi per attività nella tabella `agent_runs` (token in input e output). Il riepilogo degli ultimi 30 giorni è in `/api/dashboard`.

## Struttura

```
src/
  server.ts            Express: API, webhook, file statici, proposte automatiche
  db.ts                SQLite (node:sqlite) e schema
  auth.ts              Registrazione, login, sessioni via cookie
  schedule.ts          Orari, slot liberi, appuntamenti (ora italiana)
  agents/              client Claude, scheda attività, agente Vendite, agente Manager
  channels/            WhatsApp e invio ai contatti
  routes/api.ts        API REST dell'app e del widget
public/
  index.html           Landing
  app/                 App del titolare
  widget.js            Chat per i siti
```
