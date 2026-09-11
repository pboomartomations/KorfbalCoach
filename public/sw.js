/* KorbIQ PWA-serviceworker.
 * Bewust zonder permanente bestandscache: iedere start blijft de nieuwste
 * Vercel-versie gebruiken. Offlinegebruik kan later gecontroleerd worden
 * toegevoegd zodra de synchronisatiestrategie voor wedstrijden gereed is.
 */
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
