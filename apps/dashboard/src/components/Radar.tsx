'use client';

/**
 * Decorative animated radar. Pure CSS animation (no canvas / rAF) so it is
 * cheap to run continuously. `dim` is used for the large ambient backdrop.
 */
export function Radar({
  size = 280,
  className = '',
  dim = false,
}: {
  size?: number;
  className?: string;
  dim?: boolean;
}) {
  const blips = [
    { top: '22%', left: '64%', delay: '0s' },
    { top: '58%', left: '30%', delay: '1.1s' },
    { top: '70%', left: '72%', delay: '2.0s' },
    { top: '40%', left: '48%', delay: '0.6s' },
  ];
  return (
    <div
      aria-hidden
      className={`pointer-events-none relative ${className}`}
      style={{ width: size, height: size, opacity: dim ? 0.5 : 1 }}
    >
      {[1, 0.74, 0.5, 0.26].map((s) => (
        <div
          key={s}
          className="radar-ring"
          style={{
            top: `${(1 - s) * 50}%`,
            left: `${(1 - s) * 50}%`,
            width: `${s * 100}%`,
            height: `${s * 100}%`,
          }}
        />
      ))}
      <div
        className="absolute left-1/2 top-0 h-1/2 w-px -translate-x-1/2 bg-line-gold"
        style={{ height: '100%' }}
      />
      <div
        className="absolute left-0 top-1/2 h-px w-full -translate-y-1/2 bg-line-gold"
      />
      <div className="radar-sweep absolute inset-0 animate-sweep rounded-full" />
      {blips.map((b, i) => (
        <span key={i} className="absolute" style={{ top: b.top, left: b.left }}>
          <span className="radar-blip h-1.5 w-1.5" />
          <span
            className="radar-blip h-1.5 w-1.5 animate-ping2"
            style={{ animationDelay: b.delay }}
          />
        </span>
      ))}
      <div
        className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent"
        style={{ boxShadow: '0 0 16px 4px rgba(201,162,75,0.8)' }}
      />
    </div>
  );
}
