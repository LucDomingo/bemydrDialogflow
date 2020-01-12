'use strict';
const axios = require('axios');
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const {WebhookClient} = require('dialogflow-fulfillment');
const {dialogflow} = require('actions-on-google');

class HttpRequest {
  /*
  static urlGetId(){return "https://bemydr.herokuapp.com/symptoms";}
  static urlGetSuggestion(){return "https://bemydr.herokuapp.com/suggest";}
  static urlGetDiagnosis(){return "https://bemydr.herokuapp.com/diagnosis";}

  */
  static urlGetId(){return "https://bemydr.herokuapp.com/symptoms";}
  static urlGetSuggestion(){return "https://api.infermedica.com/v2/suggest";}
  static urlGetDiagnosis(){return "https://api.infermedica.com/v2/diagnosis";}

  static makePost(body,url){
    return new Promise((resolve,reject)=>{
      axios.post(url, body,{ headers : {'App-Id':'af6b1628','App-Key': '2089b0717534fb503ae77981797d4a2f'}})
    	.then((res) => {
      	resolve(res.data);
    	})
    	.catch((error) => {
      	reject(error);
    	});
    });
  }
}

class Database {
  static delete(userId,child){ return admin.database().ref(userId).child(child).remove(); }
  static get(userId,child){ return admin.database().ref(userId).child(child).once('value'); }
  static push(userId,child,data){ return admin.database().ref(userId).child(child).push().set(data); }
}

class Context {
  constructor(contextName){
    this.name = contextName;
  }
  set(conv,data){ return conv.contexts.set(this.name,1,data); }
  get(conv,paramName){ return conv.contexts.get(this.name).parameters[paramName]; }
  getParamFromArray(conv,index,paramName){return conv.contexts.get(this.name).parameters.res[index][paramName];}
  setLife(conv,lifes){ return conv.contexts.set(this.name,lifes); }
  getMapParam(conv,[current, ...rest]){
    if(rest.length==0){
      let res = new Map();
      return res.set(current,this.get(conv,current));
    }
    return this.getMapParam(conv,rest).set(current,this.get(conv,current));
  }
}

class Intent{
  constructor(intentName,context){
    this.name = intentName;
    this.context = new Context(context);
  }
  static close(conv,error){
    console.log(error);
    conv.close("Something went wrong, please try again");
  }
}

class initIntent extends Intent {
  constructor(name,suggestContext){
    super(name,suggestContext);
  }
  proceed(conv){
    const userSymptom =  conv.parameters.symptom;
    let param = this.context.getMapParam(conv,["sex","age","userId"]);
    return HttpRequest.makePost({ symptom : userSymptom },HttpRequest.urlGetId()) // get user symptom_ID
        .then((res)=>{
          let P1 = Database.push(param.get("userId"),"symptoms",{"choice_id" : "present" ,"id": res.id,"name":userSymptom});
          let P2 = HttpRequest.makePost({'age':param.get("age"),'sex':param.get("sex"),
                                      evidence:[{'choice_id':"present",'id':res.id}]}, HttpRequest.urlGetSuggestion()); // get first suggested symptoms round
          return Promise.all([P1,P2]);
        })
        .then((res)=>{
          return res[1];
        })
        .catch((error)=>{
            conv.close(conv,error);
        });
  }
}

class stopDiagnosis extends Intent {
  constructor(name,suggestContext){
    super(name,suggestContext);

  }
  proceed(conv){
    conv.ask("Well you're going to stop the diagnosis, If you want to really stop it say 'YES', else 'NO'");
  }
}

// ##################################################################################################################################
// ################################################# CODE REVIEW ####################################################################
// ##################################################################################################################################


class suggestIntent extends Intent {
  constructor(name,suggestContext){
    super(name);
    this.context = new Context(suggestContext);
  }

  sendSymptomHistory(conv,url){
    let symptomsHistory = [];
    let param = this.context.getMapParam(conv,["sex","age","userId"]);
    return Database.get(param.get("userId"),"symptoms")
      .then((snapshot)=>{
        snapshot.forEach(function(childSnapshot){
          var symptom = childSnapshot.val();
          symptomsHistory.push({"choice_id":symptom.choice_id,"id":symptom.id}); // {"choice_id":"headache","id":"s_125"}
        });
        return HttpRequest.makePost({age:param.get("age"),sex:param.get("sex"),evidence:symptomsHistory},url);
      })
      .catch((error)=>{
        Intent.close(conv,error);
      });
  }

  getDiagnosis(conv,userId){
    return this.sendSymptomHistory(conv,HttpRequest.urlGetDiagnosis())
      .then((res)=>{
        var today = new Date();
        var mm = today.getMonth() + 1;
        let date = today.getDate() + ':' + mm + ':' + today.getFullYear() +' '+today.getHours()+':'+today.getMinutes();
        return Database.push(userId,"diagnosis/"+date,res.conditions).then(()=> return res)
      })
      .catch((error)=>{
        Intent.close(conv,error);
      });
    }

  proceed(conv){
    return new Promise((resolve, reject)=>{
      let currentContext = this.context;
      let param = this.context.getMapParam(conv,["current","symptomsLen","counter","nbSymptomsToSuggest","nbDiseases","userId"]);
      if(param.get("counter") === param.get("nbSymptomsToSuggest") - 1){ // Nombre de suggestions fixé par l'utilisateur atteint
        this.getDiagnosis(conv,param.get("userId"))
            .then((res)=>{
              let result = res;
              var diagnosisLen = Object.keys(result.conditions).length;
              let diagnostic = "";
              for (var i=0; i<param.get("nbDiseases") && i<diagnosisLen; i++){
                diagnostic+="You may suffering from " + result.conditions[i].common_name + " with a probability of  "
                             + result.conditions[i].probability.toString() +"\n";
              }
              resolve(diagnostic);
            })
            .catch((error)=>{
              Intent.close(conv,error);
            });
      }
      else if(param.get("current") === param.get("symptomsLen") ){ // Demande d'une nouvelle vague de suggestions
        this.sendSymptomHistory(conv,HttpRequest.urlGetSuggestion())
            .then((symtomsToSuggest)=>{
              var len = Object.keys(symtomsToSuggest).length;
              currentContext.set(conv,{'symtomsToSuggest': symtomsToSuggest, 'symptomsLen': len,'current':1,'counter': param.get("counter")+1});
              resolve("Do you feel "+ symtomsToSuggest[0].name + " ?");
            })
            .catch((error)=>{
              Intent.close(conv,error);
            });
      }
      else{ // Suggestion du symptôme courant
        currentContext.set(conv,{'current':param.get("counter")+ 1, 'counter': param.get("counter")+1});
        resolve( "Do you feel "+ currentContext.get(conv,"symtomsToSuggest")[param.get("current")].name + " ?" );
      }
    })
    .catch((error)=>{
      Intent.close(conv,error);
    });
  }

}
class suggestIntentFollow extends suggestIntent{
  constructor(name,suggestContext,present){
    super(name,suggestContext);
    this.present = present ? "present" : "absent";
  }
  proceedFollow(conv){
    let param = this.context.getMapParam(conv,["userId","current","symtomsToSuggest"]);
    const symptom = param.get("symtomsToSuggest")[param.get("current")-1];
    let P1 = Database.push(param.get("userId"),"symptoms",{"choice_id" : this.present ,"id": symptom.id,"name":symptom.name});
    let P2 = this.proceed(conv);
    return Promise.all([P1,P2])
    .then(res => conv.ask(res[1]))
    .catch((error)=>{
        Intent.close(conv,error);
    });
  }
}
// ##################################################################################################################################
// ##################################################################################################################################


class stopDiagnosisNo extends suggestIntent{
  constructor(name,suggestContext){
    super(name,suggestContext);
  }
  getBackToDiagnosis(conv){
    return this.proceed(conv)
    .then(dialog => conv.ask(dialog))
    .catch((error)=>{
        this.close(conv,error);
    });
  }
}

class App {
  constructor(){
    this.app = dialogflow({debug : true});
    this.initPhase = new initIntent('init_phase','suggested_symptoms');
    this.suggestPhase = new suggestIntent('suggest_phase','suggested_symptoms');
    this.suggestPhaseUserResponseYes = new suggestIntentFollow('suggest_phase - yes','suggested_symptoms',1);
    this.suggestPhaseUserResponseNo = new suggestIntentFollow('suggest_phase - no','suggested_symptoms',0);
    this.stopDiagnosis = new stopDiagnosis('stop_diagnosis','suggested_symptoms');
    this.stopDiagnosisNo = new stopDiagnosisNo('stop_diagnosis - no','suggested_symptoms');
  }

  handleInitPhase(){
    return this.app.intent(this.initPhase.name,(conv) =>{
      const userId = "Ayman";//this.initPhase.context.get(conv,"username");
      let parameters;
      var P1 = Database.delete(userId,"symptoms");
      var P2 = Database.get(userId,"infos")
              .then((snapshot)=>{
                  parameters = {'sex':snapshot.val().sex,'age':snapshot.val().age,
                  'nbSymptomsToSuggest':snapshot.val().user_preferences.nbSymptomsToSuggest,'nbDiseases':snapshot.val().user_preferences.nbDiseases};
                  return parameters;
                }).then((parameters)=>{
                   return this.initPhase.proceed(conv);
                })
                .then((res)=>{
                  var len = Object.keys(res).length;
                  parameters.symtomsToSuggest = res;parameters.symptomsLen = len;parameters.current = 0;parameters.userId = userId;parameters.counter = 0;
                  return this.initPhase.context.set(conv,parameters);
                }).catch((error)=>{
                    Intent.close(conv,error);
                });
      return Promise.all([P1,P2]).then((array)=>{
         conv.ask("Okay, I'm gonna ask you some Yes/No questions, say 'YES' to continue, you can stop the diagnosis saying 'stop'");
      })
      .catch((error)=>{
        Intent.close(conv,error);
      });
    });
  }

  handleSuggestPhase(){
    return this.app.intent(this.suggestPhase.name,(conv) =>{
      return this.suggestPhase.proceed(conv)
        .then(param => conv.ask(param))
        .catch((error)=>{
          Intent.close(conv,error);
        });
    });
  }

  handleSuggestPhaseYes(){
    return this.app.intent(this.suggestPhaseUserResponseYes.name,(conv) =>{
      return this.suggestPhaseUserResponseYes.proceedFollow(conv);
    });
  }
  handleSuggestPhaseNo(){
    return this.app.intent(this.suggestPhaseUserResponseNo.name,(conv) =>{
      return this.suggestPhaseUserResponseNo.proceedFollow(conv);
    });
  }
  handleStopDiagnosis(){
    return this.app.intent(this.stopDiagnosis.name,(conv) =>{
      return this.stopDiagnosis.proceed(conv);
    });
  }
  handleStopDiagnosisNo(){
    return this.app.intent(this.stopDiagnosisNo.name,(conv) =>{
      return this.stopDiagnosisNo.getBackToDiagnosis(conv);
    });
  }

  listen(){
    this.handleInitPhase();
    this.handleSuggestPhase();
    this.handleSuggestPhaseYes();
    this.handleSuggestPhaseNo();
    this.handleStopDiagnosis();
    this.handleStopDiagnosisNo();
  }

}

class Main{
  static init(){
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      databaseURL: 'ws://infermedica-dialog-vghdef.firebaseio.com/',
    });
    let app = new App();
    app.listen();
    exports.dialogflowFirebaseFulfillment = functions.https.onRequest(app.app);
  }
}

Main.init();
