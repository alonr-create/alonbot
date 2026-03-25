import type { ToolHandler } from '../types.js';

const handler: ToolHandler = {
  name: 'weather',
  definition: {
    name: 'weather',
    description: 'Get current weather for a city using wttr.in',
    input_schema: {
      type: 'object' as const,
      properties: {
        city: { type: 'string', description: 'City name (e.g., "Tel Aviv", "London")' },
      },
      required: ['city'],
    },
  },
  async execute(input) {
    try {
      const city = input.city as string;
      const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;

      const res = await fetch(url, {
        headers: { 'User-Agent': 'curl/7.0' },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        return `Error: wttr.in returned ${res.status}`;
      }

      const data = (await res.json()) as any;
      const current = data.current_condition?.[0];

      if (!current) {
        return `No weather data found for "${city}".`;
      }

      const desc = current.weatherDesc?.[0]?.value || 'Unknown';
      const tempC = current.temp_C;
      const feelsLikeC = current.FeelsLikeC;
      const humidity = current.humidity;
      const windKmph = current.windspeedKmph;
      const windDir = current.winddir16Point;

      return [
        `Weather in ${city}:`,
        `  ${desc}`,
        `  Temperature: ${tempC}°C (feels like ${feelsLikeC}°C)`,
        `  Humidity: ${humidity}%`,
        `  Wind: ${windKmph} km/h ${windDir}`,
      ].join('\n');
    } catch (e: any) {
      return `Error fetching weather: ${e.message}`;
    }
  },
};

export default handler;
