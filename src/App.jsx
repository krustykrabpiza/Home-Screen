import { useEffect, useState } from "react";
import Section from "./components/Section";
import { mockStatusById } from "./data/mockStatus";

export default function App() {
  const [sections, setSections] = useState([]);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    const loadConfig = async () => {
      try {
        const response = await fetch("/services.json");
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();
        setSections(data.sections ?? []);
      } catch (error) {
        setLoadError(`Unable to load configuration: ${error.message}`);
      }
    };

    loadConfig();
  }, []);

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Homelab</p>
          <h1>Home Screen</h1>
          <p className="subtitle">A static-first dashboard for your core services</p>
        </div>
      </header>

      {loadError ? <p className="error-banner">{loadError}</p> : null}

      {!loadError && sections.length === 0 ? (
        <p className="loading-banner">Loading services...</p>
      ) : null}

      <div className="sections-wrap">
        {sections.map((section) => (
          <Section key={section.id} section={section} statuses={mockStatusById} />
        ))}
      </div>
    </main>
  );
}
