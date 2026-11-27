// Modalità d'uso. Oggi il sistema è a uso esclusivo di TL Comunicazioni:
// niente registrazioni pubbliche e niente pagina di vendita. Le funzioni di vendita
// (registrazione, landing, piani Stripe) restano nel codice e si riattivano con queste variabili.
export const PUBLIC_SIGNUP = process.env.PUBLIC_SIGNUP === "1";
export const PUBLIC_SITE = process.env.PUBLIC_SITE === "1";
