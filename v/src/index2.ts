import { setupAuthServer } from "@modelcontextprotocol/sdk/examples/server/demoInMemoryOAuthProvider.js";
import { InMemoryTaskMessageQueue, InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental"
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthMetadataRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { checkResourceAllowed } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { GetPromptResult } from "@modelcontextprotocol/sdk/spec.types.js";
import { CallToolResult, ElicitResult, ElicitResultSchema, isInitializeRequest, PrimitiveSchemaDefinition, ReadResourceResult, ResourceLink } from "@modelcontextprotocol/sdk/types.js";
import cors from 'cors';
import { resolve } from "node:dns";
import * as z from 'zod/v4';
import { Request, Response } from 'express';
import { InMemoryEventStore } from "@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js";
import { randomUUID } from "node:crypto";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";

// ?
const useOAuth = process.argv.includes('--oauth');
const strictOAuth = process.argv.includes('--oauth-strict');

const taskStore = new InMemoryTaskStore();

// cria um servidor mcp com detlhes implementados
const getServer = () => {

    const server = new McpServer(
        {
            name: "simple-streamable-http-server",
            version: '1.0.0',
            icons: [{ src: './mcp.svg', sizes: ['512x512'], mimeType: 'image/svg+xml' }],
            websiteUrl: 'https://github.com/modelcontextprotocol/typescript-sdk'
        },
        {
            capabilities: { logging: {}, tasks: { requests: { tools: { call: {} } } } },
            taskStore,
            taskMessageQueue: new InMemoryTaskMessageQueue()
        }
    )

    server.registerTool(
        "greet",
        {
            title: "Ferramenta de saudação",
            description: "Uma simples ferramenta de saudação",
            inputSchema: {
                name: z.string().describe("Nome para cumprimentar")
            }
        },
        async ({ name }): Promise<CallToolResult> => {
            return {
                content: [
                    {
                        type: "text",
                        text: `Hello, ${name}`
                    }
                ]
            }
        }
    )

    // varias sadauções com notificações
    server.registerTool(
        'multi-greet',
        {
            description: "Uma ferramenta que envia diferentes saudações com intervalo entre elas.",
            inputSchema: {
                name: z.string().describe("Nome para cumprimentar")
            },
            annotations: {
                title: "Ferramenta de saudação multipla",
                readOnlyHint: true,
                openWorldHint: false
            }
        },
        async ({ name }, extra): Promise<CallToolResult> => {

            const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

            await server.sendLoggingMessage(
                {
                    level: "debug",
                    data: `Iniciand saudações multiplas para ${name}`
                },
                extra.sessionId
            )

            await sleep(1000);

            await server.sendLoggingMessage(
                {
                    level: "info",
                    data: `Enviando primeira saudação para ${name}`
                }
            )

            await sleep(1000);

            await server.sendLoggingMessage(
                {
                    level: 'info',
                    data: `Enviando seguunda saudação para ${name}`
                },
                extra.sessionId
            );

            return {
                content: [
                    {
                        type: 'text',
                        text: `Good morning, ${name}!`
                    }
                ]
            };
        }

    )

    // ferramente que demonstra elicitação(coleta de dados do usuario com um esquema)
    // bloco de código que captura a instância do servidor
    server.registerTool(
        'collect-user-info',
        {
            description: 'Uma ferramenta que coleta informações do usuário através de formulários',
            inputSchema: {
                infoType: z.enum(["contact", "preferences", "feedback"])
            }
        },
        async ({ infoType }, extra): Promise<CallToolResult> => {

            let message: string;
            let requestedSchema: {
                type: "object"
                properties: Record<string, PrimitiveSchemaDefinition>
                required?: string[]
            }

            switch (infoType) {

                case 'contact':
                    message = "Por favor, forneça suas informações de contato"
                    requestedSchema = {
                        type: "object",
                        properties: {
                            name: {
                                type: "string",
                                title: "Nome inteiro",
                                description: "Seu nome inteiro"
                            },
                            email: {
                                type: "string",
                                title: "Endereço de email",
                                description: "Seu endereço de email",
                                format: "email"
                            },
                            phone: {
                                type: "string",
                                title: "Número de telefone",
                                description: "Seu número de telefone (opcional)"
                            }
                        },
                        required: ["name", "email"]
                    }
                    break

                case 'feedback':
                    message = 'Por favor deixe seu feedback'
                    requestedSchema = {
                        type: "object",
                        properties: {
                            rating: {
                                type: "integer",
                                title: "Classifique sua experiência",
                                description: "Classifique sua experiência (1-5)",
                                minimum: 1,
                                maximum: 5
                            },
                            comments: {
                                type: 'string',
                                title: "comentários",
                                description: "Adicione comentários (opcional)",
                                maxLength: 500
                            },
                            recommend: {
                                type: "boolean",
                                title: "Você recomendaria isso?",
                                description: "Você recomendaria isso a outras pessoas"
                            }
                        },
                        required: ['rating', 'recommend']
                    }
                    break

                default:
                    throw new Error(`Tipo de informação desconhecida: ${infoType}`)

            }

            try {

                const result = await extra.sendRequest(
                    {
                        method: "elicitation/create",
                        params: {
                            mode: "form",
                            message,
                            requestedSchema
                        }
                    },
                    ElicitResultSchema
                )

                if (result.action === "accept") {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Thank you! Informações de ${infoType} coletadas! Informações: ${JSON.stringify(result.content, null, 2)}`
                            }
                        ]
                    }
                }
                else if (result.action === "decline") {

                    return {
                        content: [
                            {
                                type: "text",
                                text: "Nenhuma informação coletada. Usuário recusou as informações solicitadas."
                            }
                        ]
                    }
                }
                else {
                    return {
                        content: [
                            {
                                type: "text",
                                text: "A coleta de informações foi cancelada pelo usuário."
                            }
                        ]
                    }
                }

            } catch (error) {

                return {
                    content: [
                        {
                            type: 'text',
                            text: `Erro ao coletar infomação ${infoType}, erro:${error}`
                        }
                    ]
                }

            }

        }
    )

    // Registra uma ferramenta que apresenta suporte bidirecional para tarefas:
    // O servidor cria uma tarefa e em seguida solicita a elicitação do cliente.
    server.experimental.tasks.registerToolTask(
        "collect-user-info-tasks",
        {
            title: "Coletar informações com Tasks",
            description: "Colete informações do usuário com suporte a Task usando elicitInputStream",
            inputSchema: {
                infoType: z.enum(['contact', 'preferences']).describe("Tipo de informação coletada").default("contact")
            }
        },
        {
            async createTask({ infoType }: any, { taskStore: createTaskStore, taskRequestedTtl }: any) {

                // cria tarefa do lado do servidor
                const task = await createTaskStore.createTask({
                    ttl: taskRequestedTtl
                })

                    // trabalho assicrono que faça uma solicitação de elicitação aninhada usando elicitInputStream
                    (async () => {

                        try {

                            const message = infoType === "contact" ? " Por favor forneça suas informações de contato" : "Por favor defina suas preferências"


                            const contactSchema: {
                                type: "object"
                                properties: Record<string, PrimitiveSchemaDefinition>
                                required: string[]
                            } = {
                                type: 'object',
                                properties: {
                                    name: { type: "string", title: "Nome inteiro", description: "Seu nome inteiro" },
                                    email: { type: "string", title: "Email", description: "Seu endereço de email" },
                                },
                                required: ['name', 'email']
                            }

                            const preferencesSchema: {
                                type: "object",
                                properties: Record<string, PrimitiveSchemaDefinition>
                                required: string[]
                            } = {
                                type: "object",
                                properties: {
                                    theme: { type: 'string', title: 'Theme', enum: ['light', 'dark', 'auto'] },
                                    notifications: { type: "boolean", title: "Ativa notificações", default: true }
                                },
                                required: ['theme']
                            }

                            const requestedSchema = infoType === "contact" ? contactSchema : preferencesSchema

                            // elicitInputStream  obtém a entrada do cliente

                            const stream = server.server.experimental.tasks.elicitInputStream({
                                mode: "form",
                                message,
                                requestedSchema
                            })

                            let elicitResult: ElicitResult | undefined

                            for await (const msg of stream) {

                                if (msg.type === "result") {
                                    elicitResult = msg.result as ElicitResult
                                }
                                else if (msg.type === "error") {
                                    throw msg.error
                                }

                            }

                            if (!elicitResult) {
                                throw new Error("Nenhum resultado obtido na solicitação")
                            }

                            let resultText: string
                            if (elicitResult.action === "accept") {

                                resultText = `Collected ${infoType} info: ${JSON.stringify(elicitResult.content, null, 2)}`
                            }
                            else if (elicitResult.action === "decline") {

                                resultText = `Usuário recusou-se a exibir informações do tipo ${infoType}`
                            }
                            else {
                                resultText = "Usuário cancelou a requisição"
                            }

                            await taskStore.storeTaskResult(task.taskId, 'completed', {
                                content: [{ type: "text", text: resultText }]
                            })


                        } catch (error) {

                            console.error("Erro em collect-user-info-task", error)
                            await taskStore.storeTaskResult(task.taskId, "failed", {
                                content: [{ type: "text", text: `Error: ${error}` }],
                                isError: true
                            })

                        }

                    })()

                return { task }
            },
            async getTask(_args, { taskId, taskStore: getTaskStore }: any) {

                return await getTaskStore.getTask(taskId)
            },
            async getTaskResult(_args, { taskId, taskStore: getResultTaskStore }) {
                const result = await getResultTaskStore.getTaskResult(taskId);
                return result as CallToolResult;
            }

        }
    )

    server.registerPrompt(
        "greeting-template",
        {
            title: "Template de saudações",
            description: "Um simples prompt template de saudações",
            argsSchema: {
                name: z.string().describe("Nome para encluir na saudação")
            }
        },

        async ({ name }): Promise<GetPromptResult> => {
            return {
                messages: [
                    {
                        role: "user",
                        content: {
                            type: "text",
                            text: `Por favor cumprimente ${name} de forma amigavel `
                        }
                    }
                ]
            }
        }
    )

    server.registerTool(
        'start-notification-stream',
        {
            description: "Inicia o envio de notificações periódicas para testes de retomada.",
            inputSchema: {
                interval: z.number().describe("intervalo em milisegundos entre notificações").default(100),
                count: z.number().describe("Número de noticações a enviar (0 a 100)").default(50)
            }
        },
        async ({ interval, count }, extra): Promise<CallToolResult> => {

            const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
            let counter = 0

            while (count === 0 || counter < count) {

                counter++

                try {

                    await server.sendLoggingMessage(
                        {
                            level: "info",
                            data: `Noticação periódica #${counter} em ${new Date().toISOString}`
                        },
                        extra.sessionId
                    )

                } catch (error) {
                    console.error('Error sending notification:', error);
                }

                await sleep(interval)

            }

            return {
                content: [
                    {
                        type: "text",
                        text: `Comecei a enviar notificações periódicas a cada ${interval}`
                    }
                ]
            }
        }
    )

    server.registerResource(
        'greeting-resource',
        'https://example.com/greetings/default',
        {
            title: "Saudação padrão",
            description: "Um recurso simples para saudação",
            mimeType: "text/plan"
        },
        async (): Promise<ReadResourceResult> => {
            return {
                contents: [
                    {
                        uri: 'https://example.com/greetings/default',
                        text: 'Ola mundo!'
                    }
                ]
            }
        }
    )

    // recursor que demonstra resourceLink
    server.registerResource(
        'example-file-1',
        'file://example/file1.txt',
        {
            title: "Exemplo arquivo 1",
            description: "Exemplo 1 de demonstração com arquivo resourceLink",
            mimeType: "text/plain"
        },
        async (): Promise<ReadResourceResult> => {

            return {
                contents: [
                    {
                        uri: 'file:///example/file1.txt',
                        text: 'Esse é o conteúdo do arquivo 1'
                    }
                ]
            }
        }
    )

    server.registerResource(
        'example-file-2',
        'file:///example/file2.txt',
        {
            title: "Exemplo arquivo 2",
            description: "Exemplo 2 de demonstração com arquivo resourceLink",
            mimeType: "text/plain"
        },
        async (): Promise<ReadResourceResult> => {
            return {
                contents: [
                    {
                        uri: 'file:///example/file2.txt',
                        text: 'Conteudo do arquivo 2'
                    }
                ]
            }
        }
    )

    // ferramenta que retorna resourceLinks
    server.registerTool(
        "list-files",
        {
            title: "Lista de arquivos com ResourceLinks",
            description: "Retorna uma lista de arquivos ResourceLinks sem incorporar o conteúdo",
            inputSchema: {
                includeDescriptions: z.boolean().optional().describe("Se devem ou não ser incluida descrições nos links de recursos")
            }
        },
        async ({ includeDescriptions = true }): Promise<CallToolResult> => {

            const resourceLinks: ResourceLink[] = [
                {
                    type: "resource_link",
                    uri: 'https://example.com/greetings/default',
                    name: 'Default Greeting',
                    mimeType: 'text/plain',
                    ...(includeDescriptions && { description: 'Um recurso simples para cumprimentos' })
                },
                {
                    type: "resource_link",
                    uri: 'file:///example/file2.txt',
                    name: "Exemplo de arquivo 2",
                    mimeType: "text/plan",
                    ...(includeDescriptions && { description: "Segundo exemplo de arquivo para demonstração ResourceLink" })
                }
            ]

            return {
                content: [
                    {
                        type: "text",
                        text: "Aqui estão os arquivos disponíveis como links de recursos."
                    },
                    ...resourceLinks,
                    {
                        type: "text",
                        text: "\nVocê pode ler qualquer um desses recursos usando seu URI."
                    }
                ]
            }

        }
    )

    // ferramenta de longa duração que demonstra a execução de tarefas

    server.experimental.tasks.registerToolTask(
        'delay',
        {
            title: "Delay",
            description: "Uma ferramenta simples que atrasa a execução de tarefas por um periódo específico, útil para testar a execução de tarefas",
            inputSchema: {
                duration: z.number().describe("Duração em milisegundos").default(5000)
            }
        },
        {
            async createTask({ duration }, { taskStore, taskRequestedTtl }) {

                const task = await taskStore.createTask({
                    ttl: taskRequestedTtl
                });

                (async () => {
                    await new Promise(resolve => setTimeout(resolve, duration));
                    await taskStore.storeTaskResult(task.taskId, 'completed', {
                        content: [
                            {
                                type: 'text',
                                text: `Completed ${duration}ms delay`
                            }
                        ]
                    });
                })();

                return {
                    task
                }
            },
            async getTask(_args, { taskId, taskStore }) {
                return await taskStore.getTask(taskId);
            },
            async getTaskResult(_args, { taskId, taskStore }) {
                const result = await taskStore.getTaskResult(taskId);
                return result as CallToolResult;
            }
        }
    )

    return server



}

const MCP_PORT = 3000
const AUTH_PORT = 3001

const app = createMcpExpressApp()

// Configura o OAuth se estiver habilitado
let authMiddleware: any = null; 

if (useOAuth) {
    const mcpServerUrl = new URL(`http://localhost:${MCP_PORT}/mcp`);
    const authServerUrl = new URL(`http://localhost:${AUTH_PORT}`);

    const oauthMetadata: OAuthMetadata = setupAuthServer({ authServerUrl, mcpServerUrl, strictResource: strictOAuth });

    const tokenVerifier = {
        verifyAccessToken: async (token: string) => {
            const endpoint = oauthMetadata.introspection_endpoint;

            if (!endpoint) {
                throw new Error('Não há endpoint de verificação de token disponível nos metadados.');
            }

            const response = await fetch(endpoint, {
                method: "POST",
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({ token: token }).toString()
            });

            if (!response.ok) {
                const text = await response.text().catch(() => null);
                throw new Error(`Token invalido ou expirado. ${text}`);
            }

            const data = await response.json();

            if (strictOAuth) {
                if (!data.aud) {
                    throw new Error(`Indicador de recurso (RFC8707) necessário`);
                }
                if (!checkResourceAllowed({ requestedResource: data.aud, configuredResource: mcpServerUrl })) {
                    throw new Error(`Indicador de recurso esperado ${mcpServerUrl}, got: ${data.aud}`);
                }
            }

            return {
                token,
                clientId: data.client_id,
                scopes: data.scope ? data.scope.split(' ') : [],
                expiresAt: data.exp
            };
        }
    }

    app.use(
        mcpAuthMetadataRouter({
            oauthMetadata,
            resourceServerUrl: mcpServerUrl,
            scopesSupported: ['mcp:tools'],
            resourceName: 'MCP Demo Server'
        })
    )

    authMiddleware = requireBearerAuth({
        verifier: tokenVerifier,
        requiredScopes: [],
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpServerUrl)
    })
} 

const transports: {[sessionId: string]: StreamableHTTPServerTransport} = {}

// handshake (define sessão)
const mcpPostHandler = async (req: Request, res: Response) => {

    // tenta pegar o id da seção.
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // verifica se é requisição do tipo initialize
    if (sessionId) {
        console.log(`Requisição MCP para a seção ${sessionId} recebida!`)
        console.log("Corpo da requisição:", req.body)

    } else {
        console.log("Corpo da requisição:", req.body)
    }

    if (useOAuth && req.auth) {
        console.log("Autenticação do usuário:", req.auth)
    }

    try {

        let transport: StreamableHTTPServerTransport

        if (sessionId && transports[sessionId]) {

            transport = transports[sessionId]
        } 
        // verifca se a seção é vazia e se a requisição é um handshake
        else if (!sessionId && isInitializeRequest(req.body)) {

            const eventStore = new InMemoryEventStore()

            // cria um novo transporte (sessão) para o cleinte
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                eventStore,
                onsessioninitialized: sessionId => {
                    console.log(`Seção iniciada com ID: ${sessionId}`)
                    transports[sessionId] = transport
                }
            })

            // configura oq fazer se a conexão fechar
            transport.onclose = () => {
                const sid = transport.sessionId
                if (sid && transports[sid]) {
                    console.log(`Trasporte fechado para a seção ${sid} removido do mapeamento de transportes`)
                    delete transports[sid]
                }
            }

            // conecta a inteligência do MCP (ferramentas, prompts) a essa sessão
            const server = getServer()
            await server.connect(transport)

            //processa a requisição
            await transport.handleRequest(req, res, req.body)
            return
        } else {
            res.status(400).json({
                jsonrpc: "2.0",
                error: {
                    code: -32000,
                    message: "Bad Request: ID de seção fornecido inválido."
                },
                id: null
            })
            return
        }

        await transport.handleRequest(req, res, req.body)

    } catch (error) {
        console.error("[Erro] na requisição MCP", error)
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: "2.0",
                error: {
                    code: -32603,
                    message: "Internal server error"
                },
                id: null
            })
        }
    }
}


if(useOAuth && authMiddleware){

    app.post("/mcp", authMiddleware, mcpPostHandler)
}
else {
    app.post('/mcp',mcpPostHandler)
}

    
const mcpGetHandler = async (req:Request, res: Response) =>{

    // sessão que foi definida no mcpPostHandler
    const sessionId = req.headers["mcp-session-id"] as string | undefined

    // verifica se a sessão existe
    if(!sessionId || !transports[sessionId]){
        res.status(400).send("Session ID inválido ou indisponível")
        return
    }

    if(useOAuth && req.auth){

        console.log(`Conexão SSE para o usuário ${req.auth} autenticada!`)
        
    }

    // pega o ultimo evento, ideal caso a internet caia
    const lastEventId = req.headers['last-event-id'] as string | undefined

    if(lastEventId){

        console.log(`Cliente reconectado com Last-Evenit-ID: ${lastEventId}`)
    }
    else{
        console.log(`Conexão SSE stream para a seção ${sessionId} realizada!`)
    }

    //tradutor da sessão
    const transport = transports[sessionId];

    // configura o cabeçalho, fala para não fechar a conexão pois vamos ficar enviando dados aos poucos
    await transport.handleRequest(req, res);

}

if (useOAuth && authMiddleware) {
    app.get('/mcp', authMiddleware, mcpGetHandler);
} else {
    app.get('/mcp', mcpGetHandler);
}

// Handle DELETE requests for session termination (according to MCP spec)
const mcpDeleteHandler = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }

    console.log(`Received session termination request for session ${sessionId}`);

    try {
        const transport = transports[sessionId];
        await transport.handleRequest(req, res);
    } catch (error) {
        console.error('Error handling session termination:', error);
        if (!res.headersSent) {
            res.status(500).send('Error processing session termination');
        }
    }
};

// Set up DELETE route with conditional auth middleware
if (useOAuth && authMiddleware) {
    app.delete('/mcp', authMiddleware, mcpDeleteHandler);
} else {
    app.delete('/mcp', mcpDeleteHandler);
}

// liga o servidor
app.listen(MCP_PORT, error => {
    if (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
    console.log(`MCP Streamable HTTP Server listening on port ${MCP_PORT}`);
});

// Handle server shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down server...');

    // Close all active transports to properly clean up resources
    for (const sessionId in transports) {
        try {
            console.log(`Closing transport for session ${sessionId}`);
            await transports[sessionId].close();
            delete transports[sessionId];
        } catch (error) {
            console.error(`Error closing transport for session ${sessionId}:`, error);
        }
    }
    console.log('Server shutdown complete');
    process.exit(0);
});





