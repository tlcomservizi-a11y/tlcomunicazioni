// Configurazione CRM: sostituire con l'endpoint e il token reali forniti dal CRM
const CRM_API_URL = 'URL_API_DEL_TUO_CRM';
const CRM_API_TOKEN = 'IL_TUO_TOKEN_API_DI_SICUREZZA';

// Funzione per inviare i dati del form al CRM di TL Comunicazioni
async function inviaDatiAlCRM(event) {
    event.preventDefault();

    // Raccoglie i dati inseriti dall'utente nel modulo del sito
    const datiContatto = {
        nome: document.getElementById('nome').value,
        email: document.getElementById('email').value,
        telefono: document.getElementById('telefono').value,
        fonte: "Academy Blog - Analisi Bolletta",
        stato_lead: "Nuovo da Gestire"
    };

    try {
        const response = await fetch(CRM_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CRM_API_TOKEN}`
            },
            body: JSON.stringify(datiContatto)
        });

        if (response.ok) {
            alert('Richiesta inviata con successo! Un consulente di TL Comunicazioni ti contatterà a breve.');
            // Qui puoi reindirizzare l'utente a una pagina di ringraziamento
        } else {
            console.error('Errore nell invio dei dati al CRM');
        }
    } catch (error) {
        console.error('Errore di rete:', error);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('form-contatto-crm');
    if (form) {
        form.addEventListener('submit', inviaDatiAlCRM);
    }
});
