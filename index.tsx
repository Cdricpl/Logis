import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Logis — Carnet d'entretien intelligent" },
      {
        name: "description",
        content:
          "Logis : ton carnet d'entretien maison. Tâches récurrentes, rappels, photos, factures — tout au même endroit.",
      },
    ],
  }),
  component: Index,
});

function Index() {
  useEffect(() => {
    window.location.replace("/api/logis");
  }, []);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "#f5f1e8",
        color: "#2a231d",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <p>Chargement de Logis…</p>
    </div>
  );
}
