import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { Timestamp } from "firebase-admin/firestore";
import * as qrcode from "qrcode";

// Inicializa o Firebase Admin SDK apenas uma vez
if (admin.apps.length === 0) {
  admin.initializeApp();
}
const db = admin.firestore();

const colecaoPartners = db.collection("partners");
const colecaoLogin = db.collection("login");

// Tipos
type LoginAttempt = {
    apiKey: string;
    loginToken: string;
    createdAt: Timestamp;
    user?: string; 
    loginConfirmedAt?: Timestamp; 
};

type CustomResponsePayload = {
    qrCode?: string;
    loginToken?: string;
    userId?: string; 
    confirmedAt?: Timestamp; 
    [key: string]: any; 
};

type CustomFunctionResponse = {
    status: "SUCCESS" | "ERROR";
    message: string;
    payload?: CustomResponsePayload | null;
};

export const performAuth = functions
  .region("southamerica-east1")
  .https
  .onCall(async (data, context) => {
    const CResponse: CustomFunctionResponse = {
        status: "ERROR",
        message: "Erro desconhecido ao realizar login.",
        payload: null,
    };

    const apiKey = data.apiKey;

    if (!apiKey) {
        functions.logger.warn("performAuth chamada sem API Key.");
        throw new functions.https.HttpsError('invalid-argument', 'API Key não fornecida.');
    }

    try {
        // CORREÇÃO AQUI: "apiKey" com K maiúsculo para corresponder ao seu Firestore
        const partnerQuery = await colecaoPartners.where("apiKey", "==", apiKey).limit(1).get(); 
        if (partnerQuery.empty) {
            CResponse.message = "API Key não encontrada ou inválida.";
            functions.logger.warn("Tentativa de login com API Key inválida:", apiKey);
            throw new functions.https.HttpsError('permission-denied', CResponse.message);
        }

        const randomBytes = Buffer.from(
            Array.from({ length: 192 }, () => Math.floor(Math.random() * 256))
        );
        const loginTokenString = randomBytes.toString("base64");

        const loginEntry: LoginAttempt = {
            apiKey: apiKey,
            loginToken: loginTokenString,
            createdAt: Timestamp.now(),
        };

        // IMPORTANTE: Usar o loginTokenString como ID do documento
        // para que o listener no frontend possa encontrá-lo facilmente.
        await colecaoLogin.doc(loginTokenString).set(loginEntry);
        const docId = loginTokenString; // O ID do documento é o próprio token
        
        const qrCodeImage = await qrcode.toDataURL(loginTokenString);

        if (docId && qrCodeImage) {
            CResponse.status = "SUCCESS";
            CResponse.message = "QR Code gerado com sucesso.";
            CResponse.payload = {
                qrCode: qrCodeImage,
                loginToken: loginTokenString,
            };
            return CResponse;
        } else {
            CResponse.message = "Erro ao criar documento de login ou gerar QR Code.";
            functions.logger.error("Falha ao salvar no Firestore ou gerar QR Code para apiKey:", apiKey, {docId: docId, hasQrCode: !!qrCodeImage});
            throw new functions.https.HttpsError('internal', CResponse.message);
        }
    } catch (error: unknown) {
        functions.logger.error("Exceção em performAuth para apiKey:", apiKey, error);
        if (error instanceof functions.https.HttpsError) {
            throw error;
        }
        let errorMessage = "Erro interno no servidor ao processar o login.";
        if (error instanceof Error) {
            errorMessage = error.message;
        }
        throw new functions.https.HttpsError('internal', errorMessage, error);
    }
  });

export const getLoginStatus = functions
  .region("southamerica-east1")
  .firestore
  .document("login/{loginId}") // Este loginId será o loginTokenString
  .onUpdate(async (change, context) => {
    const logEntry: Partial<CustomFunctionResponse> = {
        status: "ERROR", 
        message: "Verificando atualização no gatilho getLoginStatus.",
    };

    const loginDataAfter = change.after.data() as LoginAttempt;
    functions.logger.log(`Documento login/${context.params.loginId} atualizado. Verificando...`, loginDataAfter);

    if (loginDataAfter?.user && loginDataAfter?.loginConfirmedAt) {
        logEntry.status = "SUCCESS";
        logEntry.message = "Login confirmado com sucesso via gatilho.";
        logEntry.payload = { 
            userId: loginDataAfter.user, 
            confirmedAt: loginDataAfter.loginConfirmedAt 
        };
        functions.logger.log("CONFIRMADO:", context.params.loginId, logEntry.payload);
    } else {
        functions.logger.log(`PENDENTE: Atualização no documento login/${context.params.loginId} não resultou em confirmação de login ainda.`);
    }
    return null; 
  });