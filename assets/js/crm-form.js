// Funzione per inviare i dati del form al proxy server, che li inoltra al CRM
// (l'URL e il token del CRM restano solo lato server, mai esposti al browser)
async function inviaDatiAlCRM(event) {
    event.preventDefault();

    const datiContatto = {
        nome: document.getElementById('nome').value,
        email: document.getElementById('email').value,
        telefono: document.getElementById('telefono').value
    };

    try {
        const response = await fetch('/api/leads', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
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
