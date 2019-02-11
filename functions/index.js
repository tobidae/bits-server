const functions = require('firebase-functions');
const admin = require('firebase-admin');
var corsModule = require('cors');

const cors = corsModule({
    origin: true
});

admin.initializeApp();
const db = admin.database();

const validateFirebaseIdToken = (req, res) => {
    return new Promise((resolve, reject) => {
        if (!req.headers.authorization || !req.headers.authorization.startsWith('Bearer ')) {
            console.error('No Firebase ID token was passed as a Bearer token in the Authorization header.');
            reject('Unauthorized');
        }

        let idToken;
        if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
            idToken = req.headers.authorization.split('Bearer ')[1];
        }

        if (!idToken) reject('Unauthorized');
        admin.auth().verifyIdToken(idToken)
            .then(decodedIdToken => {
                resolve(decodedIdToken);
            }).catch(error => {
            console.error('Error while verifying Firebase ID token ', error);
            reject('Unauthorized');
        });
    })
};

/**
 * Order is created by passing in the userID to the create order function
 * @type {HttpsFunction}
 */
exports.placeCaseOrder = functions.https.onRequest((req, res) => {
    if ('OPTIONS' == req.method && req.body == null) {
        res.status(204).send('Preflight was good');
    }
    cors(req, res, () => {
        validateFirebaseIdToken(req, res)
            .then(user => {
                let userId = user['uid'];
                // let bodyData = req.body;

                createOrder(userId).then(() => {
                    res.status(200).send({
                        type: 'success',
                        message: 'Added order to queue'
                    })
                }).catch(error => {
                    console.log(error);
                    res.status(400).send({
                        type: 'error',
                        message: error
                    });
                });
            });
    });
});

/**
 * Anytime the status of a case changes to available, check the caseQueue to see if any user currently needs the device
 * If a user needs the device, then complete the order for that user. After that, push the queue up one by transaction
 * TODO: Send notification of the order been completed
 * @type {CloudFunction<Change<DataSnapshot>>}
 */
exports.checkCaseStatus = functions.database.ref('cases/{caseId}/isAvailable').onUpdate(async (snapshot, context) => {
    const isCaseAvailable = snapshot.after.val();
    const caseId = context.params['caseId'];

    // If the case is available and there is queue data
    // , work with the queue data object
    if (!isCaseAvailable) return;

    // Get the queue ref
    const queue = (await db.ref(`caseQueue/${caseId}/queue`).once('value')).val();

    // If there is a property of 1 in the queue, there is a user in line
    if (!queue.hasOwnProperty(1)) return;

    const userId = queue[1];
    completeOrder(userId, caseId)
        .then(() => {
            return db.ref(`caseQueue/${caseId}/queue`).transaction(queueData => {
                if (!queueData) return queueData;

                const queueLength = Object.keys(queueData).length;
                for (let i = 1; i < queueLength; i++) {
                    queueData[i] = queueData[i+1];
                }
                // Remove the last entry in the queue since queue has been pushed up
                delete queueData[queueLength];
                return queueData;
            });
        });
});

exports.processCaseOrder = functions.database.ref('caseQueues/{caseId}/queue').onUpdate(async (snapshot, context) => {
    const data = snapshot.after.val();
    const caseId = context.params['caseId'];

    // Get if the case is available
    const isCaseAvailable = (await db.ref(`cases/${caseId}/isAvailable`).once('value')).val();

    // If the case is available, work with the queue data object
    if (isCaseAvailable && data) {

        for (const index in data) {
            if (!data.hasOwnProperty(index)) break;

            const userId = data[index];
        }
    }
});


/**
 * This function creates an order for each case in a user's cart. The function adds each of the cases into the
 * queues for each of the cases.
 * @param uid
 * @returns {Promise<admin.database.DataSnapshot | null>}
 */
function createOrder(uid) {
    const cartRef = db.ref(`userCarts/${uid}`);

    // Get the snapshot of the user's cart
    return cartRef.once('value')
        .then(snapshot => {
            if (!snapshot.exists()) return null;

            // For each of the case ID, queue the order into the appropriate case queue and return a boolean value
            snapshot.forEach(snap => {
                return !!queueUserOrder(uid, snap.key);
            });
        });
}

/**
 * Queue the user based on their userID into the caseQueue by using FIFO method. When a new transaction is created,
 * check if the case is available, if it is, complete the order of the first user. Then push the log of the order
 * been created to the appropriate field then remove the case from the user's cart.
 * @param uid
 * @param caseId
 * @returns {Promise<void | never>}
 */
function queueUserOrder(uid, caseId) {
    const userHistory = db.ref(`userHistory/${uid}`);
    const cartRef = db.ref(`userCarts/${uid}/${caseId}`);

    // A nice way to always ensure that there are no duplicate or out of order orders.
    return db.ref(`caseQueues/${caseId}`).transaction(caseData => {
        if (!caseData) caseData = {};

        if (!caseData.queue) caseData.queue = {};
        const position = Object.keys(caseData.queue).length;
        caseData.queue[position + 1] = uid;

        if (!caseData.queueCount) caseData.queueCount = 0;
        caseData.queueCount++;
        return caseData;
    }).then(txData => {
        if (!txData.committed) throw new Error('Unable to add cases to queue.');
        const snap = txData.snapshot.val();
        let info = 'Order Created! ';

        if (snap.queue.uid > 1) {
            info += `You are #${snap.queue.uid} in the queue`;
        } else {
            info += `Your order has been processed.`;
        }

        return userHistory.push({
            timestamp: admin.database.ServerValue.TIMESTAMP,
            info: info,
            caseId: snap.key
        });
    }).then(() => {
        return cartRef.remove();
    }).catch(error => {
        throw new Error(error);
    });
}

/**
 * This function is triggered when the order has been completed. The order hasn't necessarily been fulfilled but it
 * should be on its way to fulfillment.
 * @param uid
 * @param caseId
 */
function completeOrder(uid, caseId) {
    const orderRef = db.ref(`completeOrders/${caseId}`);
    const pastOrderRef = db.ref(`userPastOrders/${uid}`);
    const caseRef = db.ref(`cases/${caseId}`);
    const userHistory = db.ref(`userHistory/${uid}`);
    const timestamp = admin.database.ServerValue.TIMESTAMP;

    // Add to complete order table, user's past orders and update the case availability.
    return orderRef.push({
        user: uid,
        timestamp: timestamp,
        scanned: false
    }).then(() => {
        return pastOrderRef.push({
            case: caseId,
            timestamp: timestamp
        });
    }).then(() => caseRef.child('isAvailable').update(false))
        .then(() => {
            return userHistory.push({
                timestamp: timestamp,
                info: 'Order placed',
                caseId: caseId
            });
        });
}