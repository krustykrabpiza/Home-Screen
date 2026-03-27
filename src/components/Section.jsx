import ServiceCard from "./ServiceCard";

export default function Section({ section, statuses }) {
  return (
    <section className="section">
      <div className="section-header">
        <h2 className="section-title">{section.title}</h2>
        <p className="section-description">{section.description}</p>
      </div>
      <div className="service-grid">
        {section.services.map((service) => (
          <ServiceCard
            key={service.id}
            service={service}
            status={statuses[service.id]}
          />
        ))}
      </div>
    </section>
  );
}
