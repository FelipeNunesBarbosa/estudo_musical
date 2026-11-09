# Estudo Musical MSA

Este site funciona pelo **Live Server** do VS Code. Abra a pasta `site` no VS Code, clique com o botão direito em `index.html` e escolha **Open with Live Server**. Não é necessário executar `npm start` nem instalar Node.js.

As partituras ficam em `scores/` e são lidas diretamente pelo navegador. O VexFlow desenha as notas; o áudio é sintetizado pelo navegador. Use **Projetar** para tela cheia. **Abrir MSCZ local** permite testar um arquivo fora do catálogo sem copiá-lo para a pasta.

O campo **BPM** começa no andamento original de cada lição. O metrônomo pode ser ligado ou desligado durante a reprodução; seus cliques seguem o compasso da partitura. Os volumes da partitura e do metrônomo são independentes. Alterar o BPM durante a reprodução recomeça a lição para manter a sincronização.

Para retomar uma lição no meio, clique no compasso ou na nota desejada na partitura. O compasso escolhido fica azul; ao tocar, a reprodução começa dali. Também é possível digitar o número em **Começar no compasso**. Se a lição já estiver tocando, clicar em outro ponto continua imediatamente da nova posição. **Parar** mantém o ponto selecionado para repetir o trecho.

## Adicionar partituras e novas fases

Para uma partitura aparecer na lista do site, são necessários dois passos:

1. Copie o arquivo `.mscz` para dentro de `site/scores/`. Para uma nova fase, crie uma pasta como `site/scores/fase-11/`. O nome da pasta não precisa ser alterado em nenhum outro lugar.
2. Abra `site/catalog.json` e acrescente uma entrada para cada arquivo novo. O caminho deve começar por `scores/`, usar `/` nas separações e ser exatamente igual ao nome do arquivo.

Exemplo para uma partitura da fase 11:

```json
{"phase":11,"title":"Fase 11 - Exercício 1","path":"scores/fase-11/Fase 11 - Exercício 1.mscz"}
```

O campo `phase` controla o filtro da fase e deve ser um número. O campo `title` é o texto mostrado na lista. O campo `path` é o caminho real dentro da pasta `site`.

Depois de salvar o JSON, atualize o Live Server com `Ctrl+F5`. Não é preciso alterar `index.html`, `app.js`, `styles.css` ou qualquer outro arquivo para uma partitura comum. Também não é necessário converter o `.mscz` para SVG, MP3 ou MIDI.

Para apenas testar um arquivo sem cadastrá-lo, use **＋ Abrir MSCZ local** no site. Ele será lido somente naquela sessão e não será incluído na lista depois que a página for fechada.

Antes de salvar, confira estes pontos:

- o arquivo termina em `.mscz`;
- o nome no `catalog.json` está idêntico ao nome na pasta;
- cada item está separado por vírgula;
- o último item do arquivo não termina com vírgula;
- não existem duas entradas com o mesmo `path`.

Se a partitura for movida ou renomeada, atualize o `path` correspondente no `catalog.json`. Se uma fase inteira for movida, atualize os caminhos de todas as entradas daquela fase.

O leitor atual cobre pautas, notas, pausas, armaduras, compassos, vozes adicionais, tercinas e áudio básico. Ele ainda não interpreta ligaduras, letras, dinâmicas e repetições do MuseScore; partituras complexas podem aparecer ou tocar de modo diferente do original.
