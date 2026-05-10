import { createFileRoute } from "@tanstack/react-router";
import logisHtml from "../../../public/Logis.html?raw";

// Sert l'app Logis (HTML monolithique) telle quelle.
// Inclus à la build via ?raw, donc pas d'accès filesystem au runtime Worker.
export const Route = createFileRoute("/api/logis")({
  server: {
    handlers: {
      GET: () =>
        new Response(logisHtml, {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          },
        }),
    },
  },
});
