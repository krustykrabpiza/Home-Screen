const stateMeta = {
  online: { label: "Online", className: "status-online" },
  degraded: { label: "Degraded", className: "status-degraded" },
  offline: { label: "Offline", className: "status-offline" },
  unknown: { label: "Unknown", className: "status-unknown" },
};

export default function ServiceCard({ service, status }) {
  const state = stateMeta[status?.state] ?? stateMeta.unknown;

  return (
    <a
      className="service-card"
      href={service.link}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open ${service.name}`}
    >
      <div className="card-head">
        <span className="service-icon" aria-hidden>
          {service.icon}
        </span>
        <div className="service-title-wrap">
          <h3 className="service-title">{service.name}</h3>
          <span className={`status-pill ${state.className}`}>
            <span className="status-dot" aria-hidden />
            {state.label}
          </span>
        </div>
      </div>
      <p className="service-description">{service.description}</p>
      <p className="service-detail">{status?.detail ?? "No details available"}</p>
    </a>
  );
}
