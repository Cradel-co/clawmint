export default function Skeleton({ lines = 3, style }) {
  return (
    <div className="skeleton-container" style={style} aria-busy="true" aria-label="Cargando...">
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          className="skeleton-line"
          style={{ width: `${70 + Math.random() * 30}%`, animationDelay: `${i * 0.1}s` }}
        />
      ))}
    </div>
  );
}
