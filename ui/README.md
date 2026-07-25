# Reagent Front-end

Interface web do Reagent: **Vite + React 19 + TypeScript + Tailwind v4**.

Com o backend rodando (`python -m src.server`), a interface entra em modo **LIVE**: agente real, sessões do `.reagent/` (SQLite), streaming por SSE. Sem backend, cai num modo **DEMO** com agente simulado ([src/mock/agent.ts](src/mock/agent.ts), que emite os mesmos eventos da API real).

## Rodar

```bash
npm install
npm run dev     # http://localhost:5173 (proxy /api -> 127.0.0.1:8787)
npm run build   # gera dist/, servido pelo próprio FastAPI na porta 8787
```

## Funcionalidades

| Área | Componente |
|---|---|
| Sessões: lista, busca full-text, apagar uma ou todas | [src/components/Sidebar.tsx](src/components/Sidebar.tsx) |
| Chat com streaming, chips de ferramenta, botão de stop | [src/components/Chat.tsx](src/components/Chat.tsx), [Message.tsx](src/components/Message.tsx) |
| Modal de permissão com diff e "always allow" | [src/components/PermissionModal.tsx](src/components/PermissionModal.tsx) |
| Modal de pergunta interativa do agente | [src/components/QuestionModal.tsx](src/components/QuestionModal.tsx) |
| Painel de tarefas + uso de tokens | [src/components/TodoPanel.tsx](src/components/TodoPanel.tsx) |
| Cliente da API (SSE, permissões, stop, busca, delete) | [src/api.ts](src/api.ts) |
