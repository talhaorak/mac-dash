import { motion } from "framer-motion";

interface GaugeProps {
  value: number; // 0-100
  label: string;
  sublabel?: string;
  color?: string;
  size?: number;
}

export function Gauge({
  value,
  label,
  sublabel,
  color = "#06b6d4",
  size = 120,
}: GaugeProps) {
  const strokeWidth = 8;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const arc = circumference * 0.75; // 270 degree arc
  const offset = arc - (value / 100) * arc;

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          className="-rotate-[135deg]"
          viewBox={`0 0 ${size} ${size}`}
        >
          {/* Background track */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="rgba(255,255,255,0.06)"
            strokeWidth={strokeWidth}
            strokeDasharray={`${arc} ${circumference}`}
            strokeLinecap="round"
          />
          {/* Value arc */}
          <motion.circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeDasharray={`${arc} ${circumference}`}
            strokeLinecap="round"
            initial={{ strokeDashoffset: arc }}
            animate={{ strokeDashoffset: offset }}
            transition={{ duration: 0.8, ease: "easeOut" }}
            style={{
              filter: `drop-shadow(0 0 6px ${color}50)`,
            }}
          />
        </svg>
        {/* Center label */}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold text-white font-mono">
            {Math.round(value)}
          </span>
          <span className="text-[10px] text-gray-500 -mt-0.5">%</span>
        </div>
      </div>
      <span className="text-xs font-semibold text-gray-300">{label}</span>
      {sublabel && (
        <span className="text-[10px] text-gray-500 -mt-1">{sublabel}</span>
      )}
    </div>
  );
}
