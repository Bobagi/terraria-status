# terraria-status — página de status ao vivo pra servidor tModLoader

[English](README.md) · **Português**

Uma **página de status em Node.js sem dependências** pra servidor dedicado de Terraria
modado (**tModLoader**) rodando em Docker. Mostra, ao vivo e atualizando sozinha:

- 🟢 Servidor **online/offline**, uptime, reinícios
- 👥 **Jogadores online** (nomes, sem IPs) e vagas livres
- 📊 **CPU / RAM** do container do servidor, tráfego de rede, tamanho do mundo em disco
- 🗺️ Info do mundo (nome, tamanho, dificuldade, último save) e a **versão do tModLoader rodando**
- 🧩 A **lista de mods** do servidor com links pra Steam Workshop
- 🎮 Botão **"Abrir tModLoader"** (`steam://run/1281930`) e endereço copiável

Exemplo no ar: **https://terraria.bobagi.space**

![Screenshot](docs/screenshot.png)

Feito como companheiro do
**[guia Terraria tModLoader Ubuntu Server](https://github.com/Bobagi/Terraria-tModLoader-Ubuntu-Server)** —
siga o guia primeiro pra ter o servidor rodando.

## Como funciona

```
jogadores ──HTTPS──▶ nginx ──▶ Node (127.0.0.1:3063) ──docker CLI──▶ container tmodloader
                               │  página estática + /api/status (JSON em cache)
                               └─ polling: docker stats/inspect · inject "playing" · du
```

- Um único `server.js` (zero pacotes npm) consulta o Docker em timers e mantém um snapshot
  JSON em cache; o navegador consulta `GET /api/status` a cada 5 s.
- Os jogadores online vêm do console do servidor: `docker exec <container> inject "playing"`
  e a resposta é lida com `tmux capture-pane` (a imagem JACOBSMILE roda o console num tmux).
  **Não** use `docker logs --tail` — fica lento conforme o log cresce.
- Roda **no host, não em container**, de propósito: precisa do CLI `docker`, e montar o
  `docker.sock` num container exposto à internet seria um risco bem maior.

## Requisitos

- O servidor tModLoader do guia (imagem JACOBSMILE; o helper `inject` + console em tmux
  vêm com ela)
- Node.js ≥ 18, um gerenciador de processo (PM2 no exemplo), nginx + certbot pra HTTPS

## Instalação

```bash
git clone https://github.com/Bobagi/terraria-status.git /opt/terraria-status
cd /opt/terraria-status

# ajuste a config (tabela abaixo) e:
pm2 start server.js --name terraria-status
pm2 save
```

Vhost do nginx (depois `certbot --nginx -d status.exemplo.com`):

```nginx
server {
    listen 80;
    server_name status.exemplo.com;
    location / {
        proxy_pass http://127.0.0.1:3063;
        proxy_set_header Host $host;
    }
}
```

## Configuração (variáveis de ambiente)

| Variável         | Padrão                                  | O que é                              |
|------------------|-----------------------------------------|--------------------------------------|
| `STATUS_PORT`    | `3063`                                  | Porta HTTP (mantenha atrás do nginx) |
| `STATUS_BIND`    | `127.0.0.1`                             | Bind — **mantenha localhost**        |
| `TMOD_CONTAINER` | `tmodloader`                            | Nome do container do servidor        |
| `TMOD_DATA_DIR`  | `/opt/terraria-tmodloader/data/tModLoader` | Volume de dados do servidor       |
| `TMOD_WORLD`     | `Bobagi`                                | Nome do mundo (arquivo `.wld`)       |
| `TMOD_WORLD_SIZE`| `Small`                                 | Exibido na página                    |
| `TMOD_DIFFICULTY`| `Expert`                                | Exibido na página                    |
| `TMOD_MAXPLAYERS`| `8`                                     | Vagas                                |
| `SERVER_HOST`    | `bobagi.space`                          | Endereço que os jogadores digitam    |
| `SERVER_IP`      | `46.202.144.75`                         | Endereço alternativo exibido         |
| `SERVER_PORT`    | `7777`                                  | Porta do jogo                        |

A **lista de mods** exibida é o array `MODS` no topo do `server.js` — edite pra bater com
o `TMOD_ENABLEDMODS` do seu servidor (nome, ID da Workshop, descrição de uma linha).

## Notas de segurança

- O log do console do tModLoader **contém a senha do servidor** (a imagem imprime a config
  no boot). Este app **nunca devolve linha crua de log** — extrai só nomes de jogador e
  **remove qualquer coisa que pareça IP** antes de publicar.
- A página nunca mostra a senha (diz "com senha"; o jogador pede pra você).
- Mantenha o Node em `127.0.0.1` e termine TLS no nginx.
- Caminhos malformados são rejeitados (sem traversal fora de `public/`, sem crash com
  percent-encoding inválido).

## Licença

[MIT](LICENSE)
