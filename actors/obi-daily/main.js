import { URL } from "url";
import { HttpCrawler } from "@crawlee/http";
import { getInput } from "@hlidac-shopu/actors-common/crawler.js";
import { parseHTML } from "@hlidac-shopu/actors-common/dom.js";
import { uploadToKeboola } from "@hlidac-shopu/actors-common/keboola.js";
import { cleanPrice } from "@hlidac-shopu/actors-common/product.js";
import rollbar from "@hlidac-shopu/actors-common/rollbar.js";
import { withPersistedStats } from "@hlidac-shopu/actors-common/stats.js";
import { Actor, Dataset, LogLevel, log } from "apify";

/** @typedef {import("linkedom/types/interface/document").Document} Document */

/** @enum {string} */
const Labels = {
  Start: "START",
  List: "LIST",
  Detail: "DETAIL",
  SubCat: "SUBCAT"
};

function startRequests({ document, homePageUrl }) {
  let categoryLinkList = document
    .querySelectorAll(".headr__nav-cat-col-inner > .headr__nav-cat-row > a.headr__nav-cat-link")
    .map(a => ({
      href: a.href,
      dataWebtrekk: a.getAttribute("data-webtrekk")
    }));
  if (!categoryLinkList.length) {
    categoryLinkList = document.querySelectorAll("ul.first-level > li > a").map(a => ({
      href: a.href
    }));
  }
  return categoryLinkList
    .filter(categoryObject => !categoryObject.dataWebtrekk)
    .map(categoryObject => ({
      url: new URL(categoryObject.href, homePageUrl).href,
      userData: { label: Labels.SubCat }
    }));
}

function pagesRequests({ document, url }) {
  const productCount = Number(document.querySelector(".variants")?.getAttribute("data-productcount"));
  const productPerPageCount = document
    .querySelectorAll("li.product > a")
    .filter(a => a.getAttribute("data-ui-name")).length;
  const pageCount = Math.ceil(productCount / productPerPageCount);
  return pageCount > 1
    ? Array(pageCount - 1)
        .fill(0)
        .map((_, i) => i + 2)
        .map(i => ({
          url: `${url}/?page=${i}`,
          userData: { label: Labels.List }
        }))
    : [];
}

function listUrls({ request, document, processedIds }) {
  return document
    .querySelectorAll("li.product > a")
    .filter(a => a.getAttribute("data-ui-name"))
    .map(a => a.href)
    .filter(url => !processedIds.has(url))
    .map(url => {
      processedIds.add(url);
      return new URL(url, request.url).href;
    });
}

function extractProduct({ url, document }) {
  const itemId = document.querySelector('input[name="code"]').getAttribute("value").trim();
  let currency = document.querySelector('meta[itemprop="priceCurrency"]')?.getAttribute("content");
  if (!currency) return;
  if (currency === "SKK") {
    currency = "EUR";
  }
  const discountedPrice = document.querySelector(".buybox .saving + del")?.innerText;
  const originalPrice = discountedPrice ? cleanPrice(discountedPrice) : null;
  let img = document.querySelector(".ads-slider__link").href;
  if (!img) {
    img = document.querySelector(".ads-slider__image").getAttribute("data-src");
  }
  return {
    itemUrl: url,
    itemName: document.querySelector(".overview__description >.overview__heading").innerText.trim(),
    itemId,
    currency,
    currentPrice: cleanPrice(document.querySelector('[data-ui-name="ads.price.strong"]').innerText),
    discounted: Boolean(discountedPrice),
    originalPrice,
    inStock: Boolean(document.querySelector("div.marg_b5").innerText.match(/(\d+)/)),
    img: `https:${img}`,
    category: document
      .querySelectorAll('a[class*="normal"][wt_name*="breadcrumb.level"]')
      .map(a => a.innerText)
      .join("/")
  };
}

/**
 * @param {string} url
 */
function getItemIdFromUrl(url) {
  return url.match(/p\/(\d+)(#\/)?$/)?.[1];
}

function variantsUrls({ url, document, processedIds }) {
  const crawledItemId = getItemIdFromUrl(url);
  return document
    .querySelectorAll(
      `.selectboxes .selectbox li:not([class*="disabled"]) a[wt_name*="size_variant"],
    .selectboxes .selectbox li[data-ui-name="ads.variants.color.enabled"] a[wt_name*="color_variant"]`
    )
    .map(a => {
      const productUrl = a.href;
      if (!productUrl) {
        return;
      }
      const itemId = getItemIdFromUrl(productUrl);
      if (crawledItemId === itemId || processedIds.has(itemId)) {
        return;
      }
      processedIds.add(itemId);
      return productUrl;
    })
    .filter(Boolean);
}

async function enqueueVariants({ enqueueLinks, request }, { document, processedIds, stats }) {
  const productLinkList = variantsUrls({
    url: request.url,
    document,
    processedIds
  });
  stats.add("urls", productLinkList.length);
  await enqueueLinks({
    urls: productLinkList,
    userData: { label: Labels.Detail }
  });
}

async function main() {
  log.info("Actor starts.");

  rollbar.init();

  const processedIds = new Set();
  const stats = await withPersistedStats(x => x, {
    urls: 0,
    items: 0,
    totalItems: 0,
    failed: 0
  });

  const { development, proxyGroups, maxRequestRetries, country = "cz" } = await getInput();

  if (development) {
    log.setLevel(LogLevel.DEBUG);
  }

  const homePageUrl = `https://www.obi${country === "it" ? "-italia" : ""}.${country}`;

  const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: proxyGroups,
    useApifyProxy: !development
  });

  const crawler = new HttpCrawler({
    maxRequestsPerMinute: 600,
    requestHandlerTimeoutSecs: 45,
    proxyConfiguration,
    maxRequestRetries,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
      maxPoolSize: 150
    },
    async requestHandler(context) {
      const { request, body, enqueueLinks, crawler } = context;
      const { url } = request;
      log.info(`Processing ${request.url}`);
      const { document } = parseHTML(body.toString());
      const { label } = request.userData;
      switch (label) {
        case Labels.Start:
          {
            const requests = startRequests({
              document,
              homePageUrl
            });
            stats.add("urls", requests.length);
            await crawler.requestQueue.addRequests(requests, {
              forefront: true
            });
          }
          break;
        case Labels.SubCat:
          {
            const productCount = parseInt(
              document.querySelector(".variants")?.getAttribute("data-productcount")?.replace(/\s+/g, ""),
              10
            );

            if (productCount) {
              const pageRequests = pagesRequests({ document, url });
              await crawler.requestQueue.addRequests(pageRequests, {
                forefront: true
              });
              stats.add("urls", pageRequests.length);

              const urls = listUrls({ request, document, processedIds });
              stats.add("urls", urls.length);
              await enqueueLinks({
                urls,
                userData: { label: Labels.Detail }
              });
              return;
            }

            const subCategoryList = document.querySelectorAll('a[wt_name="assortment_menu.level2"]').map(a => a.href);
            const subCatRequests = subCategoryList.map(subcategoryLink => ({
              url: new URL(subcategoryLink, homePageUrl).href,
              userData: { label: request.userData.label }
            }));

            stats.add("urls", subCatRequests.length);
            await crawler.requestQueue.addRequests(subCatRequests, {
              forefront: true
            });
          }
          break;
        case Labels.List:
          {
            const urls = listUrls({ request, document, processedIds });
            stats.add("urls", urls.length);
            await enqueueLinks({
              urls,
              userData: { label: Labels.Detail }
            });
          }
          break;
        case Labels.Detail:
          {
            stats.inc("totalItems");
            await enqueueVariants(context, {
              document,
              processedIds,
              stats
            });
            const product = extractProduct({
              url: request.url,
              document
            });
            if (product) {
              stats.inc("items");
              await Dataset.pushData(product);
            }
          }
          break;
      }
    },
    async failedRequestHandler({ request }, error) {
      log.error(`Request ${request.url} failed multiple times`, error);
      stats.inc("failed");
    }
  });

  log.info("crawler starts.");
  await crawler.run([
    {
      url: homePageUrl,
      userData: { label: Labels.Start }
    }
  ]);
  log.info("crawler finished");

  await stats.save();

  if (!development) {
    const tableName = `obi${country === "it" ? "-italia" : ""}_${country}`;
    await uploadToKeboola(tableName);
    log.info(`update to Keboola finished ${tableName}.`);
  }
  log.info("Actor Finished.");
}

await Actor.main(main);
