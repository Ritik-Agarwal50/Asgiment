/** @format */

// Import required modules
import express from "express";
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs/promises";
import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();

// Validate and retrieve the QuikNode endpoint URL
const quikNodeEndpoint = process.env.END_POINT;
if (
  !quikNodeEndpoint ||
  (!quikNodeEndpoint.startsWith("http:") &&
    !quikNodeEndpoint.startsWith("https:"))
) {
  throw new TypeError("Endpoint URL must start with `http:` or `https:`.");
}

// Initialize the Solana connection using the endpoint from environment variables
const connection = new Connection(quikNodeEndpoint);

const app = express();
const port = 3002;

// Function to validate if a string is a valid base-58 encoded Solana public key
function isValidSolanaPublicKey(address) {
  try {
    new PublicKey(address); // This will throw an error if the address is invalid
    return true;
  } catch (e) {
    return false;
  }
}

// Function to fetch transactions for a wallet address
async function getTransactions(walletAddress) {
  if (!isValidSolanaPublicKey(walletAddress)) {
    throw new Error("Invalid wallet address");
  }

  const publicKey = new PublicKey(walletAddress);

  // Fetch signatures for the wallet address
  let signatures;
  try {
    signatures = await connection.getSignaturesForAddress(publicKey);
  } catch (error) {
    console.error("Failed to fetch signatures:", error);
    throw new Error("Failed to fetch signatures");
  }

  // Function to fetch transaction details with exponential backoff and maxSupportedTransactionVersion
  async function fetchTransactionWithBackoff(signature, attempt = 1) {
    const delay = Math.min(500 * 2 ** (attempt - 1), 16000); // Exponential backoff with cap at 16 seconds
    if (attempt > 10) {
      console.log(`Max retry attempts reached for signature: ${signature}`);
      return null;
    }
    try {
      // Try fetching the transaction with maxSupportedTransactionVersion
      return await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });
    } catch (error) {
      if (
        error.message.includes(
          "failed to get transaction: Transaction version (0) is not supported"
        )
      ) {
        console.log(
          `Transaction version not supported. Retrying after ${delay}ms delay...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        return fetchTransactionWithBackoff(signature, attempt + 1);
      } else if (error.message.includes("429")) {
        console.log(
          `Server responded with 429 Too Many Requests. Retrying after ${delay}ms delay...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        return fetchTransactionWithBackoff(signature, attempt + 1);
      } else {
        throw error;
      }
    }
  }

  // Fetch transaction details for each signature with exponential backoff
  const transactions = [];
  for (let signatureInfo of signatures) {
    try {
      const transaction = await fetchTransactionWithBackoff(
        signatureInfo.signature
      );
      if (transaction) {
        // Extract transaction details
        const meta = transaction.meta;
        const preTokenBalances = meta.preTokenBalances[0] || {};
        const postTokenBalances = meta.postTokenBalances[0] || {};
        const token = meta.preTokenBalances[0]?.mint || {}; // Assuming preTokenBalances contains mint info

        const simplifiedTransaction = {
          uuid: meta.transactionHash, // Or any unique identifier if available
          network: "Solana",
          fee: meta.fee || 0,
          compute_units_consumed: meta.computeUnitsConsumed || 0,
          timestamp: transaction.blockTime
            ? new Date(transaction.blockTime * 1000).toISOString()
            : null,
          type:
            transaction.transaction.message.instructions[0]?.parsed?.type ||
            "unknown",
          wallet_address: walletAddress,
          transaction_hash: signatureInfo.signature,
          token: {
            uuid: token, // Token UUID if available
            network: "Solana",
            contract_address: preTokenBalances.mint || null,
            name: "solana", // Replace with actual token name if available
            symbol: "sol", // Replace with actual token symbol if available
            decimals: preTokenBalances.uiTokenAmount?.decimals || 0,
            display_decimals: 2, // This could be adjusted based on the token
          },
        };

        transactions.push(simplifiedTransaction);
        if (transactions.length >= 100) {
          // Limit the number of transactions
          break;
        }
      }
    } catch (error) {
      console.error(
        `Failed to fetch transaction ${signatureInfo.signature}:`,
        error
      );
    }
  }

  return transactions;
}

app.get("/transactions/:walletAddress", async (req, res) => {
  try {
    const walletAddress = req.params.walletAddress;
    const transactions = await getTransactions(walletAddress);

    // Write the transactions to a JSON file
    const filePath = `./transactions_${walletAddress}.json`;
    await fs.writeFile(filePath, JSON.stringify(transactions, null, 2));

    res.json({
      message: "Transaction data has been saved to JSON file",
      filePath,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send("Error fetching transactions");
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
