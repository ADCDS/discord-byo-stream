# BYO Stream

**Compartilhamento de tela nos canais de voz do Discord, por um servidor seu ou de um amigo.**
Para quando o Go Live do Discord não está disponível, como no Brasil desde agosto de 2026.

[English](README.md) · [Baixar](#instalação) · [Montar um servidor](docs/SERVIDOR.md)

O BYO Stream religa o Go Live do próprio Discord: o botão de compartilhar tela, a
escolha da janela, o selo AO VIVO, os quadros das transmissões, quem está assistindo e
o volume de cada transmissão funcionam como sempre. Só o vídeo e o som seguem outro
caminho: passam por um servidor [LiveKit](https://livekit.io) em vez do Discord. A
conversa de voz continua no Discord.

Todo mundo que transmite ou assiste precisa ter o BYO Stream instalado, com acesso ao
mesmo servidor.

> [!WARNING]
> O BYO Stream modifica o aplicativo do Discord. Isso vai contra os Termos de Serviço
> do Discord, que pode punir contas por isso. Use com amigos e por sua conta e risco.
> Quem mantém o servidor é responsável pelo que é transmitido por ele. O BYO Stream não
> é feito pelo Discord nem tem ligação com ele.

## Instalação

Você precisa de duas coisas de quem mantém o servidor: **o endereço do servidor** (algo
como `https://streams.exemplo.com`) e **a sua chave de acesso**. Não passe a chave para
ninguém: é ela que dá acesso ao servidor.

Use o aplicativo oficial do Discord, de [discord.com](https://discord.com/download), e
abra-o pelo menos uma vez antes de instalar. As atualizações do Discord removem o BYO
Stream. No macOS, um auxiliar em segundo plano restaura ele com o Discord fechado.
No Windows e Linux, rode o instalador de novo depois de uma atualização. Reinstalar
também atualiza o BYO Stream.

### Windows

1. Baixe **[discord-byo-stream-windows-v0.1.3.zip](https://github.com/ADCDS/discord-byo-stream/releases/download/windows-v0.1.3/discord-byo-stream-windows-v0.1.3.zip)**.
2. Clique com o botão direito no zip, escolha **Extrair Tudo** e depois **Extrair**.
3. Na pasta que abrir, dê dois cliques em **Install.cmd**.
   - Se aparecer "O Windows protegeu o computador", clique em **Mais informações** e
     depois em **Executar assim mesmo**.
   - Se perguntar se você quer abrir ou executar o arquivo, clique em **Executar**.
4. Digite ou cole o endereço do servidor e aperte Enter. Depois, a chave de acesso, e
   Enter.

O Discord reinicia já com o BYO Stream. O **Uninstall.cmd**, na mesma pasta, remove.

<details>
<summary>Ou instale pelo PowerShell</summary>

```powershell
irm https://github.com/ADCDS/discord-byo-stream/releases/download/windows-v0.1.3/install.ps1 | iex
```

Para passar as respostas em vez de digitar, ou para desinstalar:

```powershell
& ([scriptblock]::Create((irm https://github.com/ADCDS/discord-byo-stream/releases/download/windows-v0.1.3/install.ps1))) -Server https://streams.exemplo.com SUA-CHAVE
& ([scriptblock]::Create((irm https://github.com/ADCDS/discord-byo-stream/releases/download/windows-v0.1.3/install.ps1))) -Uninstall
```
</details>

### macOS

O jeito mais fácil é uma linha no Terminal:

1. Abra o **Terminal** (aperte Cmd+Espaço, digite `Terminal` e aperte Return).
2. Cole isto e aperte Return:
   ```sh
   curl -fsSL https://github.com/ADCDS/discord-byo-stream/releases/download/macos-v0.1.3/install.sh | sh
   ```
3. Digite ou cole o endereço do servidor e aperte Return. Depois, a chave de acesso, e
   Return.
4. Se aparecer **macOS blocked changes to Discord.app** (o macOS bloqueou mudanças no
   Discord.app): abra **Ajustes do Sistema** > **Privacidade e Segurança** >
   **Gerenciamento de Apps** e ative o **Terminal**. Feche o Terminal (Cmd+Q), abra de
   novo e repita o passo 2.

O Discord fecha e abre de novo já com o BYO Stream. Reinstalar mantém o servidor e a
chave salvos, sem precisar digitar de novo.

O instalador do macOS também registra um auxiliar em segundo plano. A cada minuto,
com o Discord totalmente fechado, ele restaura o BYO Stream se o Discord atualizou.
Também verifica diariamente novas versões estáveis para macOS neste repositório e
confere os checksums dos arquivos antes de instalar. Ele nunca fecha o Discord nem
interrompe chamadas. Depois de uma atualização do Discord, **feche o Discord por
completo, espere um minuto e abra de novo**.

O macOS pode bloquear mudanças feitas pelo auxiliar mesmo com a permissão do
Terminal. Se a restauração automática falhar, rode o instalador pelo Terminal; os
erros ficam no `updater.log`, na pasta de logs abaixo. Para não usar o auxiliar ou
removê-lo, acrescente `-s -- --no-auto-update` depois de `sh` no comando de instalação.
Desinstalar também remove o auxiliar. Instaladores distribuídos pelo seu VPS
restauram o gancho localmente; novas versões continuam vindo de quem mantém o servidor.

<details>
<summary>Ou baixe e dê dois cliques</summary>

1. Baixe **[discord-byo-stream-macos-v0.1.3.zip](https://github.com/ADCDS/discord-byo-stream/releases/download/macos-v0.1.3/discord-byo-stream-macos-v0.1.3.zip)**
   e abra o arquivo, se o navegador ainda não tiver aberto.
2. Dê dois cliques em **Install.command**. Na primeira vez, o macOS diz que não
   consegue verificá-lo, porque o BYO Stream não vem da App Store nem é assinado pela
   Apple:
   - macOS 15 ou mais novo: clique em **OK**, abra **Ajustes do Sistema** >
     **Privacidade e Segurança**, desça até *"Install.command" foi bloqueado*, clique em
     **Abrir Mesmo Assim** e confirme com a sua senha.
   - macOS 14 ou mais antigo: clique em **Install.command** segurando Control, escolha
     **Abrir** e depois **Abrir** de novo.
3. O Terminal abre e pede o endereço do servidor e a chave de acesso, como acima. O
   passo 4 acima vale aqui também.

O **Uninstall.command** remove, depois da mesma liberação da primeira vez.
</details>

Para desinstalar pelo Terminal:

```sh
curl -fsSL https://github.com/ADCDS/discord-byo-stream/releases/download/macos-v0.1.3/install.sh | sh -s -- --uninstall
```

### Linux

Feche o Discord por completo (inclusive o ícone na bandeja) e, num terminal:

```sh
curl -fsSL https://github.com/ADCDS/discord-byo-stream/releases/download/linux-v0.1.3/install.sh | sh
```

Ele pede o endereço do servidor e a chave de acesso; depois é só abrir o Discord. Para
desinstalar, acrescente `-s -- --uninstall` depois do `sh`. Você também pode baixar o
[discord-byo-stream-linux-v0.1.3.tar.gz](https://github.com/ADCDS/discord-byo-stream/releases/download/linux-v0.1.3/discord-byo-stream-linux-v0.1.3.tar.gz),
descompactar e rodar `sh install.sh` na pasta dele.

Precisa do `.deb` ou do `.tar.gz` do Discord, de discord.com. As versões Flatpak e Snap
não deixam alterar os próprios arquivos, então não dá para adicionar o BYO Stream a
elas.

### Instalando para outra pessoa

Para pular as perguntas, coloque o servidor e a chave no comando:

```sh
curl -fsSL https://github.com/ADCDS/discord-byo-stream/releases/download/macos-v0.1.3/install.sh | sh -s -- --server https://streams.exemplo.com SUA-CHAVE
```

(No Linux, use o endereço com `linux-v0.1.3`.) Se você mantém um servidor, o comando
`python3 keys.py add <nome>` gera uma mensagem com tudo o que um amigo precisa.

## Como usar

**Para transmitir**, entre num canal de voz e clique no botão de compartilhar tela do
Discord, como sempre.

- No Windows e no macOS, a janela do próprio Discord mostra seus aplicativos e telas,
  sem miniaturas. Escolha um, escolha a qualidade e comece a transmissão.
- No Linux, abre a janela de compartilhamento de tela do seu sistema. Escolha uma
  janela ou tela ali.

Mesmo sem Nitro dá para transmitir em até 1080p, porque o vídeo não passa pelo Discord.
Na primeira vez no macOS, permita que o Discord grave a tela quando ele pedir (Ajustes
do Sistema > Privacidade e Segurança > Gravação de Tela e Áudio do Sistema, que se
chama Gravação de Tela nos macOS mais antigos) e depois feche e abra o Discord de novo.
A primeira transmissão com som também pede permissão para gravar áudio.

**Para assistir**, clique no amigo com o selo **AO VIVO** no canal de voz, ou no quadro
da transmissão dele, como sempre. Clique com o botão direito numa transmissão para
mudar o volume dela.

A transmissão pode levar alguns segundos para ficar nítida: ela começa numa qualidade
menor e vai subindo conforme a conexão permite. As transmissões usam o codificador de
vídeo do hardware do seu computador quando o navegador do Discord oferece, como nos
Macs, então transmitir jogando gasta pouca CPU. Senão, a imagem pode diminuir quando a
CPU estiver ocupada.

Se uma atualização do Discord quebrar os botões do Go Live, o BYO Stream mostra um
painel pequeno próprio no lugar. **Ctrl+Alt+V** abre esse painel a qualquer momento,
com as estatísticas da transmissão.

### Som da transmissão

O BYO Stream envia o som do que você compartilha, e nunca a chamada de voz nem as
transmissões que você está assistindo, então ninguém ouve a própria voz de volta.

| | Compartilhando uma janela | Compartilhando a tela inteira |
|---|---|---|
| Windows 10 (2004 ou mais novo), 11 | O som do aplicativo daquela janela | Sem som |
| macOS 14.2 ou mais novo | O som do aplicativo daquela janela | Sem som |
| macOS 14.1 ou mais antigo | Sem som | Sem som |
| Linux, com PipeWire | O som do aplicativo daquela janela, se o título dela disser qual é; senão, de todos os aplicativos menos o Discord | Todos os aplicativos menos o Discord |

No Windows e no macOS, a tela inteira vai sem som porque não há como capturar tudo
menos a voz do Discord. Para mostrar um jogo ou um vídeo com som, compartilhe a janela
dele. Quando uma transmissão não pode ter o som que você pediu, o Discord mostra um
aviso dizendo o motivo.

No macOS, cada navegador conta como um aplicativo só: compartilhar uma janela do
Chrome, Edge ou Opera envia todo o som daquele navegador. Compartilhar uma janela do
Safari envia o som do Safari e de outros aplicativos feitos com o motor do Safari.
Alguns aplicativos não têm som que dê para capturar, como muitos jogos rodando pelo
Wine ou CrossOver.

## Problemas comuns

**O instalador diz que não encontrou o Discord** ("couldn't find Discord"). Instale o
aplicativo oficial do Discord, abra uma vez e rode o instalador de novo. No Linux, o
Discord Flatpak ou Snap não é suportado.

**"didn't accept that access key"** (chave recusada) ou **"couldn't reach"** (servidor
fora do ar). Copie o endereço do servidor e a chave de novo, exatamente como recebeu.
Se estiverem certos, o servidor pode estar fora do ar: fale com quem mantém ele.

**O botão de compartilhar tela está bloqueado, sumiu ou não faz nada.** Uma atualização
do Discord pode ter removido o BYO Stream, voltando o bloqueio regional. Feche o
Discord por completo (pelo ícone na bandeja ou na barra de menus, não só a janela).
No macOS, espere um minuto pelo auxiliar e abra de novo. Se continuar bloqueado, ou
no Windows/Linux, rode o instalador de novo. Quem transmite e quem assiste precisam
do BYO Stream funcionando.

**Meus amigos não veem a minha transmissão.** Eles também precisam do BYO Stream,
instalado com o mesmo servidor, e precisam estar no mesmo canal de voz.

**Tela preta ao assistir.** Espere alguns segundos. Se continuar preta, quem está
transmitindo deve parar e começar a transmissão de novo.

**Logs.** O BYO Stream grava logs numa pasta `discord-byo-stream`: em `%APPDATA%` no
Windows, em `~/Library/Application Support` no macOS e em `~/.config` no Linux. O
`plugin.log`, o `main.log` e (no macOS) o `updater.log` registram o que aconteceu, e o `status.json` mostra as
transmissões do momento. Eles nunca contêm a sua chave de acesso, então pode mandá-los
quando for pedir ajuda.

## Monte o seu servidor

Um VPS pequeno com um domínio dá conta de um grupo de amigos. Veja
[docs/SERVIDOR.md](docs/SERVIDOR.md) ([in English](docs/SERVER.md)).

## Como funciona

- **O gancho** (`installer/app-index.js`, `installer/main.js`) roda no processo
  principal do Discord. O instalador o adiciona do mesmo jeito que o BetterDiscord: o
  `app.asar` do Discord é renomeado para `byo-stream.app.asar`, e uma pastinha `app/`
  carrega o gancho antes. O gancho libera só o seu servidor na política de segurança
  de conteúdo do Discord, roda o plugin na janela principal e escolhe a fonte de som da
  transmissão.
- **O plugin** (`plugin/`) roda na página do Discord. Ele substitui o experimento do
  próprio cliente que esconde o Go Live, intercepta as ações de Go Live do Discord e
  manda a transmissão para o LiveKit. Nada disso chega aos servidores do Discord: as
  chamadas de Go Live ao gateway são descartadas, e as respostas que esses servidores
  mandariam são criadas localmente. A câmera do Discord continua desligada, porque ela
  passaria pelo Discord.
- **O servidor** (`server/`) troca a chave de acesso de cada pessoa por um token
  LiveKit de curta duração para a sala de um canal de voz. Cada canal de voz do Discord
  tem a sua sala.

O instalador guarda o endereço do servidor e a chave no `config.json` da pasta de logs
acima, que só você pode ler. As regras de som ficam em `installer/audio-source.js`
(macOS e Windows) e `installer/linux-audio.js` (PipeWire).

Desenvolvimento, versões e limitações conhecidas estão no [README em inglês](README.md#development).

## Licença

[MIT](LICENSE). Discord é uma marca da Discord Inc.; este projeto não tem ligação com ela.
