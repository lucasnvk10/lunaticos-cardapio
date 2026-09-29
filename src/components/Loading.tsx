export function Loading({ label = "Carregando" }: { label?: string }) {
  return <div className="loading"><span className="loading__orb" /><span>{label}</span></div>;
}
