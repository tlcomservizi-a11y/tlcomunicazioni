import { addMessage, getBusiness, type Contact } from "../db.js";
import { sendWhatsApp } from "./whatsapp.js";

/**
 * Invia un messaggio a un contatto sul suo canale e lo salva nella conversazione.
 * Per i canali "sito" e "test" il messaggio viene letto dal widget al prossimo aggiornamento.
 */
export async function sendToContact(contact: Contact, text: string, author: "agente" | "titolare"): Promise<void> {
  if (contact.channel === "whatsapp") {
    await sendWhatsApp(getBusiness(contact.business_id), contact.external_id, text);
  }
  addMessage(contact.business_id, contact.id, author, text);
}
