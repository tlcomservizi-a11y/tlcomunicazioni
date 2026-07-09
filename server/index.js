require('dotenv').config();
const path = require('path');
const express = require('express');

const { CRM_API_URL, CRM_API_TOKEN, PORT = 3000 } = process.env;

if (!CRM_API_URL || !CRM_API_TOKEN) {
    console.warn('Attenzione: CRM_API_URL e/o CRM_API_TOKEN non sono configurati (vedi .env.example).');
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));

app.post('/api/leads', async (req, res) => {
    const { nome, email, telefono } = req.body || {};

    if (!nome || !email || !telefono) {
        return res.status(400).json({ errore: 'Nome, email e telefono sono obbligatori.' });
    }

    if (!CRM_API_URL || !CRM_API_TOKEN) {
        console.error('Proxy CRM non configurato: impostare CRM_API_URL e CRM_API_TOKEN.');
        return res.status(500).json({ errore: 'Servizio non configurato.' });
    }

    try {
        const crmResponse = await fetch(CRM_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CRM_API_TOKEN}`
            },
            body: JSON.stringify({
                nome,
                email,
                telefono,
                fonte: 'Academy Blog - Analisi Bolletta',
                stato_lead: 'Nuovo da Gestire'
            })
        });

        if (!crmResponse.ok) {
            console.error('Il CRM ha rifiutato la richiesta:', crmResponse.status);
            return res.status(502).json({ errore: 'Il CRM ha rifiutato la richiesta.' });
        }

        res.status(200).json({ ok: true });
    } catch (error) {
        console.error('Errore di rete verso il CRM:', error);
        res.status(502).json({ errore: 'Impossibile contattare il CRM.' });
    }
});

app.listen(PORT, () => {
    console.log(`Server in ascolto su http://localhost:${PORT}`);
});
