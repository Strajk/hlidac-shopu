import { LinkeDOMCrawler, createLinkeDOMRouter } from "@crawlee/linkedom";
import { ActorType } from "@hlidac-shopu/actors-common/actor-type.js";
import { getInput } from "@hlidac-shopu/actors-common/crawler.js";
import { uploadToKeboola } from "@hlidac-shopu/actors-common/keboola.js";
import Rollbar from "@hlidac-shopu/actors-common/rollbar.js";
import { withPersistedStats } from "@hlidac-shopu/actors-common/stats.js";
import { cleanPriceText } from "@hlidac-shopu/lib/parse.mjs";
import { Actor, log } from "apify";

// Not using Labels from actors-common cause we need two separate labels for listing
const LABEL_CUSTOM = {
  INDEX: `INDEX`,
  LISTING_PREFLIGHT: `LISTING_PREFLIGHT`,
  LISTING: `LISTING`
};

const baseUrl = "https://www.smarty.cz";

async function main() {
  Rollbar.init();

  const { development, type = ActorType.Full, proxyGroups, maxRequestRetries } = await getInput();

  const stats = await withPersistedStats(x => x, {
    categories: 0, // in this actor, categories are brands
    items: 0,
    failed: 0
  });

  const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: proxyGroups,
    useApifyProxy: !development
  });

  const crawler = new LinkeDOMCrawler({
    proxyConfiguration,
    maxRequestRetries,
    requestHandler: createLinkeDOMRouter({
      [LABEL_CUSTOM.INDEX]: async ({ window: { document }, crawler }) => {
        const urls = Array.from(document.querySelectorAll(`url loc`)).map(el => el.innerText);
        // https://www.smarty.cz/Vyrobce/samsung - we wanna just these
        // https://www.smarty.cz/Vyrobce/samsung/mobilni-telefony - but not these deep urls
        const brandsUrls = urls.filter(url => url.split(`/`).length === 5);
        const { addedRequests } = await crawler.addRequests(
          brandsUrls.map(url => ({
            url: `${url}#us=1&s=n&pg=all`,
            label: LABEL_CUSTOM.LISTING_PREFLIGHT
          }))
        );
        stats.add(`categories`, brandsUrls.length);
      },
      [LABEL_CUSTOM.LISTING_PREFLIGHT]: async ({ window: { document }, crawler }) => {
        const producerId = document.querySelector(`#f_id`).value;
        const count = +document.querySelector(`#fCount`).value;
        const perPage = 12;
        const pages = Math.ceil(count / perPage);
        const urls = [];
        for (let i = 1; i <= pages; i++) {
          const url = `https://www.smarty.cz/Products/Product/ProducerProductItems?${new URLSearchParams({
            id: producerId,
            cg: `1`,
            sort: null,
            page: i.toString()
          })}`;
          urls.push(url);
        }
        await crawler.addRequests(
          urls.map(url => ({
            url,
            label: "LISTING"
          })),
          {
            forefront: true // makes debugging easier, cause it reveals problems in LISTING handler faster
          }
        );
      },
      [LABEL_CUSTOM.LISTING]: async ({ window: { document }, log }) => {
        if (document.querySelector(`.errorPage`)) {
          log.error(`errorPage`, { html: document.innerHTML });
          return;
        }
        const products = Array.from(document.querySelectorAll(`.productList-item`)).map(el => {
          const pid = el.getAttribute(`data-id`);
          const productJson = JSON.parse(el.getAttribute(`data-gaItem`));
          const urlRel = el.getAttribute(`data-url`);
          return {
            itemId: pid,
            itemUrl: `${baseUrl}${urlRel}`,
            itemName: productJson.name,
            currentPrice: productJson.fullPrice,
            originalPrice:
              el.querySelector(`.font-crossed`) &&
              parseFloat(cleanPriceText(el.querySelector(`.font-crossed`)?.textContent)),
            currency: `CZK`,
            img: el.querySelector(`picture img`)?.getAttribute(`src`),
            inStock: productJson.available.includes(`Skladem`)
          };
        });
        stats.add(`items`, products.length);
        await Actor.pushData(products);
      }
    }),
    failedRequestHandler({ request, log }, error) {
      log.error(`Request ${request.url} failed ${request.retryCount} times`, error);
      stats.inc("failed");
    }
  });

  if (type === ActorType.Full) {
    await crawler.run([{ url: `${baseUrl}/Feed/Sitemap/Producers`, label: LABEL_CUSTOM.INDEX }]);
  } else if (type === ActorType.Test) {
    await crawler.run([
      {
        url: `${baseUrl}/Vyrobce/samsung#us=1&s=n&pg=all`,
        label: LABEL_CUSTOM.LISTING_PREFLIGHT
      }
    ]);
  } else {
    throw new Error(`Unknown actor type ${type}, supported types are ${ActorType.Full} and ${ActorType.Test}`);
  }

  await stats.save(true);

  if (!development) {
    await uploadToKeboola("smarty_cz");
  }

  log.info("Finished.");
}

await Actor.main(main);
