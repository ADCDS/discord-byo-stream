# Montando um servidor do BYO Stream

[English](SERVER.md) · [Voltar ao README](../README.pt-BR.md)

Um servidor do BYO Stream tem duas partes, as duas em `server/`:

- **O LiveKit**, que leva o vídeo e o som das transmissões.
- **O serviço de tokens**, que confere a chave de acesso de cada pessoa e a coloca na
  sala do LiveKit do canal de voz em que ela está.

Seus amigos instalam o BYO Stream pelas releases deste repositório e digitam o
endereço do seu servidor e a chave que você der a eles. A partir daí, o Discord deles
usa o seu servidor para as transmissões. O resto do Discord não muda.

## Do que você precisa

- **Um servidor Linux com IP público.** Um VPS pequeno (1 vCPU, 1 GB de RAM) dá conta
  de um grupo de amigos. A banda importa mais que a CPU: o servidor manda uma cópia da
  transmissão para cada pessoa assistindo, até uns 10 Mbit/s cada em 1080p60. Uma
  transmissão em 1080p30 com quatro pessoas assistindo precisa de uns 20 Mbit/s de
  upload no servidor.
- **Um domínio ou subdomínio** apontando para esse IP, como `streams.exemplo.com`. Se
  ele estiver na Cloudflare, deixe como *DNS only* (nuvem cinza): a mídia do LiveKit
  não passa por proxy.
- **Docker** com o plugin Compose, e o **Caddy** para o HTTPS. Qualquer outro proxy
  reverso com suporte a WebSocket também serve.
- **Portas abertas:** 443/tcp para o HTTPS, 7881/tcp, e de 50000 a 60000/udp para o
  LiveKit.

Os comandos abaixo são para Debian ou Ubuntu, rodados por um usuário comum que pode
usar o Docker. Eles pegam o seu domínio da variável `DOMAIN`, então defina ela antes,
no mesmo terminal:

```sh
DOMAIN=streams.exemplo.com   # o seu domínio
```

## 1. Baixe os arquivos

```sh
git clone https://github.com/ADCDS/discord-byo-stream ~/discord-byo-stream
cd ~/discord-byo-stream/server
```

## 2. Configure o LiveKit

Copie o exemplo e gere uma chave e um segredo de API só seus:

```sh
cp livekit.example.yml livekit.yml
sed -i "s/^  REPLACE_WITH_API_KEY: .*/  API$(openssl rand -hex 6): $(openssl rand -hex 32)/" livekit.yml
```

O padrão usa as portas listadas acima. Se mudar alguma, ajuste o firewall também.

## 3. Configure o serviço de tokens

```sh
cp .env.example .env
sed -i "s/streams.example.com/$DOMAIN/; s/^UID_GID=.*/UID_GID=$(id -u):$(id -g)/" .env
mkdir -p data && chmod 700 data && echo '{}' > data/keys.json
```

O `.env` diz onde fica o LiveKit (`LIVEKIT_URL`), liga o LiveKit que vem junto
(`COMPOSE_PROFILES`) e lê a chave do LiveKit no `livekit.yml`.

## 4. Inicie

```sh
docker compose up -d
docker compose ps
```

O `tokens` e o `livekit` devem aparecer como `Up`. O `docker compose logs` mostra o
que eles estão fazendo. Eles voltam sozinhos depois de reiniciar o servidor.

## 5. Configure o HTTPS

Instale o Caddy e coloque as rotas do `Caddyfile.example` em `/etc/caddy/Caddyfile`,
com o seu domínio no lugar de `streams.example.com`:

```sh
sudo apt install caddy
sudo cp Caddyfile.example /etc/caddy/Caddyfile
sudo sed -i "s/streams.example.com/$DOMAIN/" /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Se o Caddy já serve um site nesse domínio, coloque os blocos `route` dentro do bloco
desse site, antes de qualquer regra que pegue todos os caminhos. O Caddy tira o
certificado HTTPS sozinho, assim que o domínio aponta para o servidor e a porta 443
está aberta.

Teste de qualquer computador:

```sh
curl https://$DOMAIN/dstream/health
```

Deve aparecer `{"ok": true}`.

## 6. Abra o firewall

Se você usa o `ufw`:

```sh
sudo ufw allow 443/tcp
sudo ufw allow 7881/tcp
sudo ufw allow 50000:60000/udp
```

Provedores de nuvem costumam ter um firewall próprio no painel. Abra as mesmas portas
lá também.

## 7. Dê chaves aos seus amigos

Cada pessoa recebe a sua própria chave, assim dá para tirar o acesso de uma sem
afetar as outras:

```sh
python3 keys.py add alice     # cria uma chave e mostra uma mensagem para mandar à Alice
python3 keys.py list          # quem tem chave
python3 keys.py revoke alice  # remove a chave da Alice, na hora
```

A mensagem traz o endereço do seu servidor, a chave da Alice e o link do guia de
instalação. A chave aparece uma vez só, porque o servidor guarda apenas o hash SHA-256
dela. Se ela se perder, rode `add` de novo para gerar outra.

Quem tem uma chave pode usar a banda do seu servidor e entrar na sala de transmissão
de qualquer canal de voz cujo ID conheça. Só dê chaves a quem você confia, e remova as
que não forem mais necessárias.

## Atualizando

```sh
cd ~/discord-byo-stream && git pull
cd server && docker compose up -d --force-recreate
```

Cada pessoa atualiza o próprio BYO Stream rodando o instalador de uma release mais
nova.

## Se você já tem um LiveKit

Dá para usar um servidor LiveKit que você já tenha, desde que ele responda em
`wss://SEU-DOMINIO/livekit`, no mesmo domínio do serviço de tokens. O BYO Stream só
libera esse domínio na política de segurança do Discord. No `.env`:

- apague a linha `COMPOSE_PROFILES=livekit`, para o LiveKit que vem junto não iniciar;
- aponte `LIVEKIT_YML` para o seu `livekit.yml`, ou preencha `LIVEKIT_API_KEY` e
  `LIVEKIT_API_SECRET`.

Depois rode `docker compose up -d` e acrescente a rota `/dstream/*` do
`Caddyfile.example` ao seu site.

## Servindo o instalador você mesmo (opcional)

Normalmente as pessoas baixam o BYO Stream do GitHub. Você também pode servir os
arquivos pelo seu servidor, com o seu endereço já sugerido como resposta. Num
computador com Node.js 22, numa cópia deste repositório:

```sh
cp byo-stream.config.example.json byo-stream.config.json   # em "server", ponha https://SEU-DOMINIO
cd plugin && npm ci --ignore-scripts && node build.mjs
```

Copie a pasta `dist/public` para o servidor, ative a rota `/dstream/dl/*` no seu
Caddyfile com essa pasta como `root` e recarregue o Caddy. Aí dá para instalar com:

```sh
curl -fsSL https://SEU-DOMINIO/dstream/dl/install.sh | sh
```

ou, no Windows, `irm https://SEU-DOMINIO/dstream/dl/install.ps1 | iex`.

## Problemas comuns

- **O `curl .../dstream/health` falha.** Confira o `docker compose ps` e depois o
  Caddy, com `sudo journalctl -u caddy -n 50`. Erro de certificado costuma querer dizer
  que o domínio ainda não aponta para este servidor, ou que a porta 443 está fechada.
- **As pessoas conectam mas a transmissão fica preta.** A mídia do LiveKit não está
  passando. Confira se 7881/tcp e 50000 a 60000/udp estão abertas em todos os
  firewalls, e se não há proxy ou CDN na frente do domínio. O
  `docker compose logs livekit` mostra o IP público que o LiveKit encontrou, que tem
  que ser o IP público real do servidor.
- **O instalador diz que o servidor "doesn't look like a BYO Stream server"** (não
  parece um servidor do BYO Stream). Falta a rota `/dstream/*`, ou ela aponta para a
  porta errada.
- **"didn't accept that access key"** (chave recusada). A chave não está no
  `data/keys.json`: confira com `python3 keys.py list` e, se precisar, gere outra com
  `add`.
- Redes muito restritas, que bloqueiam o UDP e a porta 7881, não conseguem conectar. O
  LiveKit pode retransmitir para elas por TURN na porta 443, o que exige um domínio e
  um certificado próprios: veja a [documentação do LiveKit](https://docs.livekit.io/home/self-hosting/deployment/).
