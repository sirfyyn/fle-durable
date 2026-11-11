/**
 * modelltor.js — antwortet der Modellserver?
 *
 * FLE Durable läuft neben einem Modell, das der Mensch lädt und wieder entlädt (FLE Link: ohne geladenes Modell
 * antwortet `/v1/models` mit 503). Ohne dieses Tor ging ein Ereignis in dieser Zeit an den Agenten, die Anfrage
 * scheiterte dreimal, und das Ereignis war verbraucht (gemessen 10.11.2026). Mit dem Tor bleibt es in der
 * Warteschlange, bis der Server wieder antwortet.
 *
 * Geprüft wird `GET <baseUrl>/models`: Status 200 heißt offen. Das Ergebnis gilt `frischMs` lang, damit die
 * Warteschlange nicht bei jedem Blick anfragt. Ginnys Runner benutzt das Tor nicht (er hat die Provider-Kette).
 */
export class ModellTor {
  constructor({ baseUrl, apiKey = '', fetchImpl = globalThis.fetch, jetzt = () => Date.now(), frischMs = 4000, timeoutMs = 3000 } = {}) {
    this.url = `${String(baseUrl ?? '').replace(/\/+$/, '')}/models`;
    this.apiKey = apiKey || '';
    this.fetch = fetchImpl;
    this.jetzt = jetzt;
    this.frischMs = frischMs;
    this.timeoutMs = timeoutMs;
    this._stand = null; // { offen, grund, zeit }
  }

  /** Letztes Ergebnis ohne neue Anfrage (für Anzeigen): { offen, grund } oder null, solange nie geprüft wurde. */
  get stand() {
    return this._stand ? { offen: this._stand.offen, grund: this._stand.grund } : null;
  }

  /** true, wenn der Modellserver antwortet. Fragt höchstens alle `frischMs` neu. */
  async offen() {
    const jetzt = this.jetzt();
    if (this._stand && jetzt - this._stand.zeit < this.frischMs) return this._stand.offen;
    let offen = false;
    let grund = '';
    const steuerung = new AbortController();
    const timer = setTimeout(() => steuerung.abort(), this.timeoutMs);
    try {
      const antwort = await this.fetch(this.url, {
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
        signal: steuerung.signal,
      });
      offen = antwort.status === 200;
      if (!offen) grund = `Status ${antwort.status}`;
      await antwort.body?.cancel?.().catch(() => {});
    } catch (fehler) {
      grund = fehler?.name === 'AbortError' ? 'keine Antwort' : String(fehler?.cause?.code ?? fehler?.message ?? 'nicht erreichbar');
    } finally {
      clearTimeout(timer);
    }
    this._stand = { offen, grund, zeit: jetzt };
    return offen;
  }
}
