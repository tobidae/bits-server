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

                addOrderToQueue(userId).then(() => {
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

    function addOrderToQueue(uid) {
        const cartRef = db.ref(`userCarts/${uid}`);
        return cartRef.once('value')
            .then(snapshot => {
                if (!snapshot.exists()) return null;

                // For each of the case ID, add it to the appropriate case queue
                snapshot.forEach(snap => {
                    // A nice way to always ensure that there are no duplicate or out of order orders.
                    db.ref(`caseQueues/${snap.key}`).transaction(caseData => {
                        if (!caseData) caseData = {};

                        if (!caseData.queue) caseData.queue = {};
                        const position = Object.keys(caseData.queue).length;
                        caseData.queue[position] = uid;

                        if (!caseData.queueCount) caseData.queueCount = 0;
                        caseData.queueCount++;
                        return caseData;
                    }).then(txData => {
                        if (!txData.committed) throw new Error('Unable to add cases to queue.');

                        return cartRef.remove();
                    });
                });
            });
    }
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

// TODO When a case is available, check the case's queue for if someone wants the device