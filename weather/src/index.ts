import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod'
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";


const API_URL = 'https://api.weather.gov'
const USER_AGENT = "weather-app/1.0";

const server = new McpServer({
    name: "weather",
    version: "1.0.0"
})


// faz a requisição
const getWeather = async <T extends object>(url: string): Promise<T | null> => {

    const headers = {
        "User-agent": USER_AGENT,
        Accept: "application/geo+json"
    }

    try {

        const response = await fetch(url, { headers })

        if (!response.ok) {
            throw new Error(`Erro na requisição HTTP! Status:${response.status}`)
        }

        return (await response.json()) as T

    } catch (error) {

        console.error("Erro ao obter dados meteorológicos", error)

        return null

    }

}

interface AlertFeature {

    properties: {
        event?: string
        areaDesc?: string
        severity?: string
        status?: string
        headline?: string
    }
}

const formatAlert = (feature: AlertFeature): string => {

    const props = feature.properties

    return [

        `Evento : ${props.event || "Desconhecida"}`,
        `Area: ${props.areaDesc || "Desconhecida"}`,
        `Severidade: ${props.severity || "Desconhecida"}`,
        `Status: ${props.status || "Desconhecido"}`,
        `Headline: ${props.headline || "Desconecido"}`,
        "---"
    ].join("\n")
}

interface ForecastPeriod {

    name?: string,
    temperature?: number,
    temperatureUnit?: string,
    windSpeed?: string,
    windDirection?: string,
    shortForecast?: string

}

interface AlertsResponse {
    features: AlertFeature[]
}

interface PointsResponse {
    properties: {
        forecast?: string
    }
}

interface ForecastResponse {

    properties: {
        periods: ForecastPeriod[]
    }
}

server.registerTool(
    "get_alerts",
    {
        description: "Receba alertas metereológicos para um estado",
        inputSchema: {
            state: z.string().length(2).describe("Sigla ou nome do estado (ex: CA, NY, TX, Texas, Califórnia)")
        }
    },
    async ({ state }) => {

        const stateCode = state.toUpperCase()
        const alertsUrl = `${API_URL}/alerts?area=${stateCode}`
        const alertsData = await getWeather<AlertsResponse>(alertsUrl)

        if (!alertsData) {

            return {
                content: [
                    {
                        type: "text",
                        text: "Falha ao obter alertas meteorológicos. Tente novamente mais tarde."
                    }
                ]
            }
        }

        const features = alertsData.features || []

        if (features.length === 0) {

            return {
                content: [
                    {
                        type: 'text',
                        text: `Nenhum alerta meteorológico ativo para ${stateCode}.`
                    }
                ]
            }
        }

        const formattedAlerts = features.map(formatAlert)
        const alertsText = `Alertas ativos para ${stateCode}:\n\n${formattedAlerts.join("\n")}`

        return {
            content: [
                {
                    type: "text",
                    text: alertsText
                }
            ]
        }

    }
)

server.registerTool(
    "get_forecast",
    {
        description: "Obtenha a previsão do tempo para uma localização",
        inputSchema: {
            latitude: z.number().min(-90).max(90).describe("Latitude da localização"),
            longitude: z.number().min(-180).max(180).describe("Longitude da localização")
        }

    },
    async ({ latitude, longitude }) => {

        const pointsUrl = `${API_URL}/points/${latitude.toFixed(4)},${longitude.toFixed(4)}`
        const pointsData = await getWeather<PointsResponse>(pointsUrl)

        if (!pointsData) {

            return {

                content: [
                    {
                        type: "text",
                        text: "Falha ao obter dados de localização. Verifique as coordenadas e tente novamente."
                    }
                ]
            }
        }

        const forecastUrl = pointsData.properties?.forecast
        if (!forecastUrl) {
            return {
                content: [
                    {
                        type: "text",
                        text: "Não foi possível obter a URL de previsão para esta localização."
                    }
                ]
            }
        }

        const forecastData = await getWeather<ForecastResponse>(forecastUrl);

        if (!forecastData) {

            return {
                content: [
                    {
                        type: "text",
                        text: "Falha ao obter dados de previsão. Tente novamente mais tarde."
                    }
                ]
            }
        }

        const periods = forecastData.properties?.periods || []

        if (periods.length === 0) {
            return {
                content: [
                    {
                        type: "text",
                        text: "Nenhuma informação de previsão disponível para esta localização."
                    }
                ]
            }
        }

        const formattedForecast = periods.map((period: ForecastPeriod) => [

            `${period.name || "Desconhecido"}:`,
            `Temperatura: ${period.temperature || "Desconhecida"} ${period.temperatureUnit || ""}`,
            `${period.shortForecast || "Previsão curta indisponível"}`,
            "---"
        ].join("\n")
        )

        const forecastText = `Previsão para ${latitude}, ${longitude}: \n\n${formattedForecast.join("\n")}`

        return {
            content: [
                {
                    type:"text",
                    text:forecastText
                }
            ]
        }

    }
)

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Weather MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});


