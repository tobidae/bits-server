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
 * Anytime a new user is added to a case queue, check if the case in question is available. If it is, take the first
 * user from the queue and push every user up one.
 * @type {CloudFunction<Change<DataSnapshot>>}
 */
exports.processCaseOrder = functions.database.ref('caseQueues/{caseId}/queue').onUpdate(async (snapshot, context) => {
    const data = snapshot.after.val();
    const caseId = context.params['caseId'];
    const parentRef =

    // Get if the case is available
    const isCaseAvailable = (await db.ref(`cases/${caseId}/isAvailable`).once('value')).val();

    // If the case is available and there is queue data
    // , work with the queue data object
    if (isCaseAvailable && data) {

        if (!data.hasOwnProperty(1)) return;

        const userId = data[1];
        completeOrder(userId, caseId)
            .then(() => {
                for (let i = 1; i < Object.keys(data).length; i++) {
                    data[i] = data[i+1];
                }
            })

    }
});


/**
 * This function creates an order for each case in a user's cart. If the case is presently available and there is
 * no queue for the case, immediately process the user's order. If the case has a line for it or it is unavailable,
 * create a queue and add the user to the bottom of the queue. First In First Out.
 * @param uid
 * @returns {Promise<admin.database.DataSnapshot | null>}
 */
function createOrder(uid) {
    const cartRef = db.ref(`userCarts/${uid}`);

    // Get the snapshot of the user's cart
    return cartRef.once('value')
        .then(snapshot => {
            if (!snapshot.exists()) return null;

            // For each of the case ID, do the required checks to determine how to get the user the case.
            snapshot.forEach(async snap => {
                const isCaseAvailable = (await db.ref(`cases/${snap.key}/isAvailable`).once('value')).val();

                // If the case is available, complete the order for user without need for a queue.
                if (isCaseAvailable) {
                    return completeOrder(uid, snap.key);
                }

                queueUserOrder(uid, snap.key);
            });
        });
}

/**
 * This function is triggered when the order has been completed. The order hasn't necessarily been fulfilled but it
 * should be on its way there.
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
        timestamp: timestamp
    }).then(() => {
        return pastOrderRef.push({
            case: caseId,
            timestamp: timestamp
        })
    }).then(() => caseRef.child('isAvailable').update(false))
        .then(() => {
            return userHistory.push({
                timestamp: timestamp,
                info: 'Order placed',
                caseId: caseId
            });
        });
}

function queueUserOrder(uid, caseId) {
    const userHistory = db.ref(`userHistory/${uid}`);
    const cartRef = db.ref(`userCarts/${uid}`);

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

// TODO When a case is available, check the case's queue for if someone wants the device