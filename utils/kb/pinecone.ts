import { Pinecone } from "@pinecone-database/pinecone";

let client: Pinecone | undefined;

function getPinecone(): Pinecone {
  if (!client) {
    const apiKey = process.env.PINECONE_API_KEY;
    if (!apiKey) throw new Error("PINECONE_API_KEY is not set");
    client = new Pinecone({ apiKey });
  }
  return client;
}

export function getLegislationIndex() {
  const indexName = process.env.PINECONE_INDEX;
  if (!indexName) throw new Error("PINECONE_INDEX is not set");
  // Namespace per rag-search/materials/legislation-clean/_pipeline/04_upsert_pinecone.py default.
  return getPinecone().index(indexName).namespace("albania-legislation");
}

export function getKtpIndex() {
  const indexName = process.env.PINECONE_INDEX;
  if (!indexName) throw new Error("PINECONE_INDEX is not set");
  return getPinecone().index(indexName).namespace("albania-ktp");
}

export function getNtcCircolareIndex() {
  const indexName = process.env.PINECONE_INDEX;
  if (!indexName) throw new Error("PINECONE_INDEX is not set");
  return getPinecone().index(indexName).namespace("ntc-circolare");
}

export function getEurocodeIndex() {
  const indexName = process.env.PINECONE_INDEX;
  if (!indexName) throw new Error("PINECONE_INDEX is not set");
  return getPinecone().index(indexName).namespace(process.env.PINECONE_NAMESPACE_EUROCODE ?? "eurocode-kb");
}
