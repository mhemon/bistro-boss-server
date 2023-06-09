const express = require('express')
const cors = require('cors');
require('dotenv').config();
const jwt = require('jsonwebtoken');
const app = express()
const stripe = require('stripe')(process.env.PAYMENT_SECRET_KEY)
const port = process.env.PORT || 5000

// middleware
app.use(cors())
app.use(express.json())

const verifyJWT = (req, res, next) => {
  const authorization = req.headers.authorization
  if (!authorization) {
    return res.status(401).send({ error: true, message: 'unauthorized access!' })
  }
  const token = authorization.split(' ')[1]
  jwt.verify(token, process.env.SECRET_ACCESS_TOKEN, (err, decoded) => {
    if (err) {
      return res.status(403).send({ error: true, message: 'unauthorized access!' })
    }
    req.decoded = decoded
    next();
  })
}


const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const { default: Stripe } = require('stripe');
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ntvgsob.mongodb.net/?retryWrites=true&w=majority`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    client.connect();

    const usersCollection = client.db("bistroDb").collection('users');
    const menuCollection = client.db("bistroDb").collection('menu');
    const reviewCollection = client.db("bistroDb").collection('review');
    const cartCollection = client.db("bistroDb").collection('cart');
    const paymentCollection = client.db("bistroDb").collection('payments');

    //jwt code
    app.post('/jwt', (req, res) => {
      const user = req.body
      const token = jwt.sign(user, process.env.SECRET_ACCESS_TOKEN, { expiresIn: '1h' });
      res.send({ token })
    })

    //verify admin for security
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email
      const query = { email: email };
      const user = await usersCollection.findOne(query)
      if (user?.role !== 'admin') {
        return res.status(403).send({ error: true, message: 'forbidden access!' })
      }
      next();
    }

    // user related api
    app.get('/users', verifyJWT, verifyAdmin, async (req, res) => {
      const result = await usersCollection.find().toArray()
      res.send(result)
    })

    app.get('/user-home',verifyJWT, async (req, res) => {
      const email = req.query.email
      const query = { email: email }
      const payments = await paymentCollection.find(query).toArray()
      const totalPrice = (payments.reduce((sum, payment) => payment.price + sum, 0)).toFixed(2)
      const totalMenu = payments.reduce((sum, item) => item.menuItems.length + sum, 0)
      const result = {
        totalMenu: totalMenu,
        totalOrder: payments.length,
        totalPayment: totalPrice
      }
      res.send(result)
    })

    // check admin user
    // jwt security
    // check user token and user email are same
    app.get('/users/admin/:email', verifyJWT, async (req, res) => {
      const email = req.params.email
      if (email !== req.decoded.email) {
        res.send({ admin: false })
      }
      const query = { email: email };
      const user = await usersCollection.findOne(query)
      const result = { admin: user?.role === 'admin' }
      res.send(result)
    })

    // make user admin
    app.patch('/users/admin/:id',verifyJWT, verifyAdmin, async (req, res) => {
      const id = req.params.id
      const filter = { _id: new ObjectId(id) }
      const updateDoc = {
        $set: {
          role: 'admin'
        },
      };
      const result = await usersCollection.updateOne(filter, updateDoc)
      res.send(result)
    })

    app.post('/users', async (req, res) => {
      const user = req.body
      const query = { email: user.email }
      const existingUser = await usersCollection.findOne(query)
      if (existingUser) {
        return res.send({ message: 'user already exist!' })
      }
      const result = await usersCollection.insertOne(user)
      res.send(result)
    })

    // menu related api

    app.get('/menu', async (req, res) => {
      const result = await menuCollection.find().toArray()
      res.send(result)
    })

    app.post('/menu', verifyJWT, verifyAdmin, async (req, res) => {
      const newItem = req.body
      const result = await menuCollection.insertOne(newItem)
      res.send(result)
    })

    app.delete('/menu/:id', verifyJWT, verifyAdmin, async (req, res) => {
      const id = req.params.id
      const query = { _id: new ObjectId(id) }
      const result = await menuCollection.deleteOne(query)
      res.send(result)
    })

    // review related api

    app.get('/reviews', async (req, res) => {
      const result = await reviewCollection.find().toArray()
      res.send(result)
    })

    // carts related api

    app.post('/carts', async (req, res) => {
      const cart = req.body
      const result = await cartCollection.insertOne(cart)
      res.send(result)
    })

    app.get('/carts', verifyJWT, async (req, res) => {
      const email = req.query.email
      if (!email) {
        res.send([])
      }
      const decoded = req.decoded
      if (decoded.email !== req.query.email) {
        return res.status(403).send({ error: true, message: 'forbidden access!' })
      }
      const cursor = cartCollection.find({ "email": email });
      const result = await cursor.toArray();
      res.send(result)
    })

    app.delete('/carts/:id', async (req, res) => {
      const id = req.params.id
      const query = { _id: new ObjectId(id) }
      const result = await cartCollection.deleteOne(query)
      res.send(result)
    })

    // create payment intent
    app.post('/create-payment-intent', verifyJWT, async (req, res) => {
      const { price } = req.body;
      const amount = parseInt(price * 100);
      const paymentIntent = await stripe.paymentIntents.create({
        amount: amount,
        currency: 'usd',
        payment_method_types: ['card']
      });

      res.send({
        clientSecret: paymentIntent.client_secret
      })
    })

    // payment related api
    app.post('/payments', verifyJWT, async (req, res) => {
      const payment = req.body;
      const insertResult = await paymentCollection.insertOne(payment);
      const query = { _id: { $in: payment.cartItems.map(id => new ObjectId(id)) } }
      const deleteResult = await cartCollection.deleteMany(query)
      res.send({ insertResult, deleteResult });
    })

    // payment history api
    app.get('/payment-history', verifyJWT, async (req, res) => {
      const email = req.query.email
      const query = { email: email };
      const result = await paymentCollection.find(query).toArray()
      res.send(result)
    })

    // admin stats

    app.get('/admin-stats', verifyJWT, verifyAdmin, async (req, res) => {
      const users = await usersCollection.estimatedDocumentCount()
      const products = await menuCollection.estimatedDocumentCount();
      const orders = await paymentCollection.estimatedDocumentCount();
      const payment = await paymentCollection.find().toArray();
      const revenue = (payment.reduce((sum, payment) => payment.price + sum, 0)).toFixed(2)
      res.send({
        revenue,
        users,
        products,
        orders
      })
    })

    app.get('/order-stats', verifyJWT, verifyAdmin, async (req, res) => {
      const pipeline = [
        {
          $lookup: {
            from: 'menu',
            localField: 'menuItems',
            foreignField: '_id',
            as: 'menuItemsData'
          }
        },
        {
          $unwind: '$menuItemsData'
        },
        {
          $group: {
            _id: '$menuItemsData.category',
            count: { $sum: 1 },
            total: { $sum: '$menuItemsData.price' }
          }
        },
        {
          $project: {
            category: '$_id',
            count: 1,
            total: { $round: ['$total', 2] },
            _id: 0
          }
        }
      ];

      const result = await paymentCollection.aggregate(pipeline).toArray();
      res.send(result)
    })

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);


app.get('/', (req, res) => {
  res.send('Boss is running........')
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})