let instances = [];


async function loadInstances() {

  try {

    toast("Loading instances...");


    const region =
      getRegion();


    const response =
      await fetch(
        `/api/instances?region=${encodeURIComponent(region)}`
      );


    const data =
      await response.json();


    if (!response.ok) {

      throw new Error(
        data.message
      );

    }


    instances = data;


    renderInstances(
      instances
    );


    updateSummary();


    toast(
      `${instances.length} instance(s) loaded.`
    );


  } catch (error) {

    toast(
      error.message
    );

  }

}


function updateSummary() {

  const running =
    instances.filter(
      item =>
        item.state === "running"
    ).length;


  const volumes =
    instances.reduce(
      (total, item) =>
        total + item.volumes.length,
      0
    );


  document.getElementById(
    "instanceCount"
  ).textContent =
    instances.length;


  document.getElementById(
    "runningCount"
  ).textContent =
    running;


  document.getElementById(
    "volumeCount"
  ).textContent =
    volumes;

}


function renderInstances(data) {

  const table =
    document.getElementById(
      "instanceTable"
    );


  table.innerHTML = "";


  if (!data.length) {

    table.innerHTML = `
      <tr>
        <td colspan="8">
          <div class="empty">
            No instances found.
          </div>
        </td>
      </tr>
    `;

    return;
  }


  data.forEach(instance => {

    const row =
      document.createElement("tr");


    row.innerHTML = `

      <td>
        <strong>
          ${escapeHtml(instance.name)}
        </strong>
      </td>

      <td class="mono">
        ${escapeHtml(instance.instanceId)}
      </td>

      <td>
        ${statusHtml(instance.state)}
      </td>

      <td>
        ${escapeHtml(instance.instanceType)}
      </td>

      <td>
        ${escapeHtml(instance.privateIp)}
      </td>

      <td>
        ${escapeHtml(instance.availabilityZone)}
      </td>

      <td>
        ${instance.volumes.length}
      </td>

      <td>

        <button
          class="btn btn-secondary btn-small"
          onclick="openVolumes('${instance.instanceId}')"
        >
          Volumes
        </button>

      </td>

    `;


    table.appendChild(row);

  });

}


function openVolumes(instanceId) {

  window.location.href =
    `/pages/volumes.html?instanceId=${encodeURIComponent(instanceId)}`;

}


/* Search */

document.addEventListener(
  "DOMContentLoaded",
  () => {

    const search =
      document.getElementById(
        "instanceSearch"
      );


    if (search) {

      search.addEventListener(
        "input",
        () => {

          const term =
            search.value
              .toLowerCase()
              .trim();


          const filtered =
            instances.filter(
              instance => {

                return [

                  instance.name,

                  instance.instanceId,

                  instance.privateIp,

                  instance.instanceType,

                  instance.availabilityZone,

                  instance.state

                ]
                  .join(" ")
                  .toLowerCase()
                  .includes(term);

              }
            );


          renderInstances(
            filtered
          );

        }
      );

    }


    loadInstances();

  }
);
