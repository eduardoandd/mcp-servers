import { setupAuthServer } from "@modelcontextprotocol/sdk/examples/server/demoInMemoryOAuthProvider.js";
import { InMemoryEventStore } from "@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js";
import { InMemoryTaskMessageQueue, InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { mcpAuthMetadataRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { checkResourceAllowed } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { CallToolResult, ElicitResult, ElicitResultSchema, GetPromptResult, isInitializeRequest, PrimitiveSchemaDefinition, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { resolve } from "node:dns";
import { z } from "zod/v4";

const useOAuth = process.argv.includes('--oauth');
const strictOAuth = process.argv.includes('--oauth-strict');

const app = createMcpExpressApp()
let authMiddleware:any = null

const MCP_PORT = 3000
const AUTH_PORT = 3000

if(useOAuth){

    // servidor MCP
    const mcpServerUrl = new URL(`http://localhost:${MCP_PORT}/mcp`)

    // servidor de autenticação
    const authServerUrl = new URL(`http://localhost:${AUTH_PORT}`)

    // cria e configura o servidor de autenticação e testa na memória e pega os metadados dele..
    const oauthMetadata: OAuthMetadata = setupAuthServer({authServerUrl, mcpServerUrl, strictResource: strictOAuth})

    // Objeto que verifica se o token é verdadeiro
    const tokenVerifier = {

        verifyAccessToken: async (token:string) => {

            const endpoint = oauthMetadata.introspection_endpoint

            if(!endpoint){
                throw new Error("Não há endpoint de verificação de token disponível nos metadados.")   
            }

            const response = await fetch(endpoint, {
                method:"POST",
                headers:{
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({token:token}).toString()
            })

            if(!response.ok){

                const text = await response.text().catch(() => null)
                throw new Error(`Token invalidado ou expirado. ${text}`)
            }

            const data = await response.json()

            if(strictOAuth){

                if(!data.aud){
                    throw new Error(`Indicador de recurso (RFC8707) necessário`)
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



// ??
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {}
const taskStore = new InMemoryTaskStore()

// cria um servidor MCP com detlahes implementados
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
            taskMessageQueue: new InMemoryTaskMessageQueue
        }
    )

    server.registerTool(
        "greet",
        {
            title: "Ferramenta de saudação!",
            description: "Uma simples ferramenta de saudação",
            inputSchema: {
                name: z.string().describe("Nome para cumpimentar")
            }
        },
        async ({ name }): Promise<CallToolResult> => {
            return {
                content: [
                    {
                        type: "text",
                        text: `Olá!, ${name}`
                    }
                ]
            }
        }
    )

    server.registerTool(
        "multi-greet",
        {
            description:"Uma ferramenta que envia diferentes saudações com intervalo entre elas.",
            inputSchema: {
                name:z.string().describe("Nome para cumprimentar")
            },
            annotations: {
                title:"Ferramenta de saudação multipla",
                readOnlyHint:true,
                openWorldHint:false
            }
        },
        async ({name}, extra):Promise<CallToolResult> => {

            const sleep = (ms:number) => new Promise(resolve => setTimeout(resolve,ms))

            await server.sendLoggingMessage(
                {
                    level:"debug",
                    data:`Iniciando saudações multiplas para ${name}`
                },
                extra.sessionId
            )

            await sleep(5000)

            await server.sendLoggingMessage(
                {
                    level:"info",
                    data:`Enviando primeira saudação para ${name}`
                },
                extra.sessionId
            )

            await sleep(2000)

            await server.sendLoggingMessage(
                {
                    level:"info",
                    data:`Enviando segunda saudação para ${name}`
                },
                extra.sessionId
            )
            await sleep(500)

            return{
                content:[
                    {
                        type:"text",
                        text:`Bom dia! ${name}`
                    }
                ]
            }

        }
    )

    server.registerTool(
        'collect-user-info',
        {
            description:"Uma ferramenta que coleta informações do usuário através de formulários",
            inputSchema: {
                infoType: z.enum(["contact", "preferences", "feedback"])
            }
        },
        async ({infoType},extra): Promise<CallToolResult> =>{

            let message: string
            let requestedSchema: {
                type:"object"
                properties:Record<string, PrimitiveSchemaDefinition>
                required?:string[]
            }

            switch(infoType){

                case 'contact':
                    message = "Por favor, forneça suas informações de contato"
                    requestedSchema = {

                        type:"object",
                        properties: {
                            name: {
                                type:"string",
                                title:"Nome inteiro",
                                description:"Seu nome inteiro"
                            },
                            email :{
                                type:"string",
                                title:"Endereço de email",
                                description:"Seu endereço de email",
                                // format:"email"
                            },
                            phone: {
                                type:"string",
                                title:"Número de telefone",
                                description:"Seu número de telefone (opcional)"
                            }
                        },
                        required: ["name","email"]

                    }
                    break
                
                case 'feedback':
                    message = "Por favor deixe seu feedback"
                    requestedSchema = {
                        type:"object",
                        properties: {
                            rating: {
                                type:"integer",
                                title:"Classifique sua experiência",
                                description:"Classifique sua experiência (1-5)",
                                minimum:1,
                                maximum:5
                            },
                            comments: {
                                type:"string",
                                title:"comentários",
                                description:"Adicione comentários (opcional)",
                                maxLength:500
                            },
                            recommend: {
                                type:"boolean",
                                title:"Você recomendaria isso?",
                                description:"Você recomendaria isso a outras pessoas"
                            }
                        },
                        required: ['rating','recommend']
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
                            mode:"form",
                            message,
                            requestedSchema
                        }
                    },
                    ElicitResultSchema
                )

                if(result.action ==="accept"){
                    return {
                        content: [
                            {
                                type:"text",
                                text: `Obrigado! Informações de ${infoType} coletadas! Informações: ${JSON.stringify(result.content, null, 2)}`

                            }
                        ]
                    }
                }
                else if(result.action ==="decline"){

                    return {
                        content: [
                            {
                                type:"text",
                                text:"Nenhuma informação coletada. Usuário recusou as informações solicitadas."
                            }
                        ]
                    }
                }
                else{
                    return {
                        content: [
                            {
                                type:"text",
                                text:"A coleta de informações foi cancelada pelo usuário."
                            }
                        ]
                    }
                }

            } catch (error) {

                return {
                    content: [
                        {
                            type:"text",
                            text:`Erro ao coletar informação ${infoType}, erro:${error}`
                        }
                    ]
                }
                
            }

        }
    )
    
    // Ferramenta que demonstra suporte bidirecional para tarefas
    //O servidor cria uma tarefa depois solicita a entrada do cliente usando elictInputStream
    server.experimental.tasks.registerToolTask(
        "collect-user-info-task",
        {
            title:"Coleta informações com a tarefa",
            description:"Coleta informações do usuário por meio de elicitação com suporte a tarefas usando elicitInputStream",
            inputSchema:{
                infoType:z.enum(['contact','preferences']).describe("Tipo de informações coletadas").default("contact")
            }
        },
        {
            async createTask({infoType}, {taskStore: createTaskStore, taskRequestedTtl}:any) {

                // cria tarefa do lado servidor
                const task = await createTaskStore.createTask({
                    ttl:taskRequestedTtl
                });

                // Realiza um trabalho assicrono que faça uma solicitação de elicitação aninhada usando elicitInputStream.

                (async () => {
                    try {
                        
                        const message = infoType === "contact" ? "Por favor forneça suas informações de contato": "Por favor defina suas preferências"

                        // Define esquemas com tipagem adequada para PrimitiveSchemaDefinition
                        const contactSchema: {
                            type:"object",
                            properties:Record<string, PrimitiveSchemaDefinition>
                            required:string[]
                        } ={
                            type:"object",
                            properties: {
                                name: {type:"string", title:"Nome inteiro", description:"Seu nome inteiro"},
                                email:{type:"string", title:"Email",description:"Seu endereço de email"}

                            },
                            required: ["name","email"]
                        }

                        const preferencesSchema: {
                            type:"object"
                            properties: Record<string, PrimitiveSchemaDefinition>;
                            required: string[]
                        } = {
                            type:"object",
                            properties:{
                                theme:{type:"string", title:"Theme", enum:['light', 'dark','auto']},
                                notifications:{type:"boolean", title:"Ativa notificações",default:true}
                            },
                            required:['theme']
                        }

                        const requestedSchema= infoType === "contact" ? contactSchema: preferencesSchema

                        // Use elicitInputStream para obter a entrada do cliente
                        // API de elicitação de fluxo continuo
                        const stream = server.server.experimental.tasks.elicitInputStream({
                            mode: "form",
                            message,
                            requestedSchema
                        })

                        let elicitResult: ElicitResult | undefined

                        for await (const msg of stream){

                            if(msg.type === 'result'){
                                elicitResult = msg.result as ElicitResult
                            }
                            else if (msg.type === "error"){
                                throw msg.error
                            }
                        }

                        if(!elicitResult){
                            throw new Error("Nenhum resultado foi obtido na elicitação")
                        }

                        let resultText:string

                        if(elicitResult.action === "accept"){
                            
                            resultText = `Informações coletadas do tipo ${infoType} info: ${JSON.stringify(elicitResult.content, null,2)}`
                            
                        }
                        else if(elicitResult.action ==="decline"){
                            resultText = `Usuário recusou receber informações: ${infoType}`
                        }
                        else{
                            resultText = `Usuário cancelou a requisição.`
                        }

                        await taskStore.storeTaskResult(task.taskId, "completed",{
                            content: [{type:"text", text:resultText}]
                        })
                    } catch (error) {

                        console.error("[Error] na ferramenta collect-user-info-task: ", error)
                        await taskStore.storeTaskResult(task.taskId, 'failed', {
                            content: [{type:"text", text: `Error: ${error}`}],
                            isError:true
                        })
                        
                    }
                })()

                return {task}

            },

            async getTask(_args, { taskId, taskStore: getTaskStore }:any) {
                return await getTaskStore.getTask(taskId);
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
            title:"Template de saudações",
            description:"Um simples propmt template de sudações",
            argsSchema:{
                name:z.string().describe("Nome para incluir na saudação")
            }
        },

        async ({name}): Promise<GetPromptResult> => {
            return {
                messages: [
                    {
                        role:"user",
                        content: {
                            type:"text",
                            text: `Por favor cumprimente ${name} de forma amigavel`
                        }
                    }
                ]
            }
        }

    )

    server.registerTool(
        'start-notification-stream',
        {
            description:"Inicia o envio de noticações periódicas para testes de retomada.",
            inputSchema:{
                interval:z.number().describe("Intervalo em milisegundos entre notificações").default(100),
                count: z.number().describe("Número de notificações a enviar (0 a 100)").default(50)
            }
        },
        async ({interval, count}, extra): Promise<CallToolResult> => {

            const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve,ms))
            let counter = 0

            while (count === 0 || counter < count){

                counter++

                try {
                    
                    await server.sendLoggingMessage(
                        {
                            level:"info",
                            data:`Notificação periódica #${counter} em ${new Date().toISOString()}`
                        },
                        extra.sessionId
                    )

                } catch (error) {
                    console.error("Erro ao enviar notificação", error)
                }

                await sleep(interval)

            }

            return {
                content: [
                    {
                        type:"text",
                        text:`Comecei a enviar notificações periódicas a cada ${interval}`
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



    return server

}



const mcpPostHandler = async (req: Request, res: Response) => {


    // tente pegar o id da seção.
    const sessionId = req.headers['mcp-session-id'] as string | undefined

    if (sessionId) {

        console.log(`Requisição MCP para a seção ${sessionId} recebida!`)
        console.log("Corpo da requisição", req.body)
    }
    else {
        console.log("Corpo da requisição", req.body)
    }

    if (useOAuth && req.auth) {
        console.log("Autenticação do usuário", req.auth)
    }

    try {

        let transport: StreamableHTTPServerTransport

        if (sessionId && transports[sessionId]) {

            transport = transports[sessionId]

        }
        //Verifica se é requisição do tipo handshake
        else if (!sessionId && isInitializeRequest(req.body)) {

            const eventStore = new InMemoryEventStore()


            // cria uma seção
            transport = new StreamableHTTPServerTransport({

                sessionIdGenerator: () => randomUUID(),
                eventStore,
                onsessioninitialized: sessionId => {

                    console.log(`Seção iniciada com ID: ${sessionId}`)
                    transports[sessionId] = transport

                }

            })


            // Remove a sessão caso a conexão feche
            transport.onclose = () => {

                const sid = transport.sessionId

                if (sid && transports[sid]) {
                    delete transports[sid]
                    console.log(`Conexão fechada! Seção ${sid} removida!`)
                }

            }

            // conecta a inteligência MCP a essa sessão
            const server = getServer()
            await server.connect(transport)

            //processa a requisição
            await transport.handleRequest(req, res, req.body)
            return
        }
        else {

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
                    message: "Erro interno do servidor"
                },
                id: null
            })
        }

    }


}

if(useOAuth && authMiddleware){
    app.post("/mcp", authMiddleware, mcpPostHandler)
}
else{
    app.post("/mcp",mcpPostHandler)
}



const mcpGetHandler = async(req: Request, res:Response) => {

    const sessionId = req.headers["mcp-session-id"] as string | undefined

    if(!sessionId || !transports[sessionId]){
        res.status(400).json("Session ID inválido ou indisponível")
        return
    }

    if(useOAuth && req.auth){
        console.log(`Conexão SSE para o usuário ${req.auth} autenticada!`)
    }

    const lastEventId = req.headers["last-event-id"] as string | undefined

    if(lastEventId){
        console.log(`Cliente reconectado com Last-Evenit-ID: ${lastEventId}`)
    }
    else{
        console.log(`Conexão SSE stream para a seção ${sessionId} realizada!`)

    }

    const transport = transports[sessionId]

    await transport.handleRequest(req, res);

}

if (useOAuth && authMiddleware) {
    app.get('/mcp', authMiddleware, mcpGetHandler);
} else {
    app.get('/mcp', mcpGetHandler);
}



app.listen(3000, error => {

    if (error) {
        console.error("[ERRO] falha ao iniciar o servidor.", error)
        process.exit(1)
    }

    console.log("Servidor MCP HTTP Streamable ouvindo a porta: ", MCP_PORT)
})


