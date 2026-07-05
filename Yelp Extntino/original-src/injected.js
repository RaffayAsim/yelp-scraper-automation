(function(a){
  a = XMLHttpRequest.prototype;
  var c = a.open, b = a.send;
  a.open = function(d,e){ this._method = d; this._url = e; return c.apply(this, arguments); };
  a.send = function(d){
    this.addEventListener("readystatechange", function(){
      const u = typeof this._url === "string" ? this._url : "";
      if (u.includes("/gql/batch") && this.readyState === 4) {
        window.postMessage({ type: "map", data: this.response }, "*");
      }
    });
    return b.apply(this, arguments);
  };
})(XMLHttpRequest);

const { fetch: origFetch } = window;
window.fetch = async (...a) => {
  const c = await origFetch(...a);
  const req = a[0];
  const url = typeof req === "string" ? req : (req && typeof req.url === "string" ? req.url : "");
  if (url.includes("/search/snippet")) {
    c.clone().json().then((b) => {
      window.postMessage({ type: "search", data: b }, "*");
    }).catch((b) => console.error(b));
  }
  return c;
};