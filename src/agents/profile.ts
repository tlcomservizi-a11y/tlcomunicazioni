import type { Business } from "../db.js";
import { hoursText } from "../schedule.js";

/** Scheda dell'attività condivisa da tutti gli agenti ("Ivot lo impara una volta"). */
export function businessCard(b: Business): string {
  return `<attivita>
Nome: ${b.name}
Settore: ${b.sector || "non indicato"}
Città/zona: ${b.city || "non indicata"}

Descrizione:
${b.description || "(non compilata)"}

Servizi e prezzi:
${b.services || "(non compilati: se il cliente chiede un prezzo, di' che lo farai sapere dal titolare)"}

Orari di apertura:
${hoursText(b)}
Durata standard di un appuntamento: ${b.slot_minutes} minuti

Domande frequenti e informazioni utili:
${b.faq || "(nessuna)"}

Tono di voce: ${b.tone}

Cliente ideale e regole di qualifica (decise dal titolare):
${b.qualification_rules || "(non indicate: considera promettente chi mostra un bisogno concreto, è nella zona servita e vuole agire a breve)"}
</attivita>`;
}
