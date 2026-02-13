import {
  AreaChart,
  Area,
  ResponsiveContainer,
  YAxis,
} from "recharts";

interface MiniChartProps {
  data: { value: number }[];
  color?: string;
  height?: number;
}

export function MiniChart({
  data,
  color = "#06b6d4",
  height = 40,
}: MiniChartProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={`grad-${color}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.3} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <YAxis domain={[0, 100]} hide />
        <Area
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={1.5}
          fill={`url(#grad-${color})`}
          animationDuration={300}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
