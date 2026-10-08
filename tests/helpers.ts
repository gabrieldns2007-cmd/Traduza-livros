import { writeEpub } from "@/services/export/epub-writer";

/** EPUB sintético com o que costuma dar trabalho: itálico, links, notas, quebras, listas, conteúdo misto. */
export function fixtureEpub() {
  return writeEpub({
    title: "The Lighthouse Keeper",
    author: "Test Author",
    language: "en",
    chapters: [
      {
        title: "Chapter One",
        body: `<h1 id="c1">Chapter One</h1>
<p>Maria walked to the <em>old</em> lighthouse at dawn, where <strong>Captain Reyes</strong> was waiting.<a id="ref1" href="ch002.xhtml#n1"><sup>1</sup></a></p>
<p>“Are you coming?” asked Captain Reyes.<br/>“Yes,” she said.</p>
<p>* * *</p>
<blockquote><p>The sea remembers everything.</p></blockquote>
<div class="note">Mixed content text <span class="it">here</span><p>and a nested paragraph.</p></div>`,
      },
      {
        title: "Chapter Two",
        body: `<h1>Chapter Two</h1>
<p>The village of Porto Velho slept while Maria climbed the stairs.</p>
<ul><li>First item about Reyes</li><li>Second <em>item</em></li></ul>
<p id="n1">1. A note about the lighthouse.</p>`,
      },
    ],
  });
}
