function openAccessModal() {

  document
    .getElementById("accessModal")
    .classList.add("open");

}


function closeAccessModal() {

  document
    .getElementById("accessModal")
    .classList.remove("open");

}


async function connectAWS() {

  const accessKeyId =
    document
      .getElementById("accessKeyId")
      .value
      .trim();


  const secretAccessKey =
    document
      .getElementById("secretAccessKey")
      .value
      .trim();


  const sessionToken =
    document
      .getElementById("sessionToken")
      .value
      .trim();


  if (
    !accessKeyId ||
    !secretAccessKey
  ) {

    toast(
      "Access Key ID and Secret Access Key are required."
    );

    return;

  }


  try {

    toast(
      "Connecting to AWS..."
    );


    const response =
      await fetch(
        "/api/connect",
        {

          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({

            accessKeyId,

            secretAccessKey,

            sessionToken

          })

        }
      );


    const result =
      await response.json();


    if (!response.ok) {

      throw new Error(
        result.message
      );

    }


    closeAccessModal();


    updateConnection(true);


    document.getElementById(
      "accessTitle"
    ).textContent =
      "AWS connected";


    document.getElementById(
      "accessDescription"
    ).textContent =
      "AWS credentials are active for this session.";


    document.getElementById(
      "accessKeyId"
    ).value = "";


    document.getElementById(
      "secretAccessKey"
    ).value = "";


    document.getElementById(
      "sessionToken"
    ).value = "";


    toast(
      "AWS connection successful."
    );


  } catch (error) {

    toast(
      error.message
    );

  }

}
